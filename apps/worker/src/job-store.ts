// 转码任务认领与状态机（ADR-0008：不引入 Redis，靠 DB 认领 + lease 崩溃重派）
//
// 认领用 **CAS 条件更新**（updateMany + 状态/lease 过滤）：MySQL 与 SQLite 语义一致，
// 多实例并发时也只有一个能成功（count=1）。ADR-0008 提到 MySQL 的 `FOR UPDATE SKIP LOCKED`
// 作为高并发演进项——CAS 已保证不重复认领，只是并发吞吐略低，故 v1 不做方言分支。
// lease 过期即视为 worker 崩溃，任务可被重新认领，attempts 递增；超过上限判失败。
import { ACTIVE_JOB_STATUSES as CONTRACT_ACTIVE_JOB_STATUSES, JOB_STATUSES } from "@openvod/contracts";
import { getDb } from "@openvod/db";

export type JobStatusName = (typeof JOB_STATUSES)[number];

/** 未终结状态：处于这些状态且 lease 已过期的任务可被重新认领（唯一真相源在 contracts） */
export const ACTIVE_JOB_STATUSES: JobStatusName[] = [...CONTRACT_ACTIVE_JOB_STATUSES];

export interface TranscodeJobRow {
  id: string;
  mediaId: string;
  status: JobStatusName;
  templateId: string | null;
  /** 发起时的模板快照（ADR-0014 防漂移） */
  templateSnapshot: unknown;
  attempts: number;
  startedAt: Date | null;
}

export interface TranscodeJobStore {
  /** 认领一个可执行任务（已把 status 推进到 PROBING 并续上 lease）；无可执行任务返回 null */
  claim(opts: { leaseMs: number; maxAttempts: number }): Promise<TranscodeJobRow | null>;
  setStatus(
    id: string,
    status: JobStatusName,
    patch?: { lastError?: string | null; finishedAt?: Date | null; leaseUntil?: Date | null; progress?: number | null },
  ): Promise<void>;
  /** 阶段进度上报（0–100；DOWNLOADING / ENCODING 阶段有意义，其余阶段清空） */
  setProgress(id: string, progress: number): Promise<void>;
  /** 执行期心跳续期（长转码任务不被重派） */
  extendLease(id: string, leaseMs: number): Promise<void>;
}

function toRow(row: {
  id: string;
  mediaId: string;
  status: string;
  templateId: string | null;
  templateSnapshot: unknown;
  attempts: number;
  startedAt: Date | null;
}): TranscodeJobRow {
  return {
    id: row.id,
    mediaId: row.mediaId,
    status: row.status as JobStatusName,
    templateId: row.templateId,
    templateSnapshot: row.templateSnapshot,
    attempts: row.attempts,
    startedAt: row.startedAt,
  };
}

/**
 * `last_error` 列长上限（Prisma `String` 在 MySQL 的默认类型 VARCHAR(191)）。
 * ffmpeg 失败消息是 stderr 片段（数百字符），超长会触发 Prisma P2000 让**失败状态写不进库**：
 * 任务卡在 PROBING/ENCODING（管理端一直显示「转码中」），lease 过期后还会被反复重认领烧 attempts
 * （2026-10-17 线上踩坑：9 个任务停摆的放大器）。完整 stderr 仍在 worker 日志，这里收敛即可。
 */
export const LAST_ERROR_MAX_CODEPOINTS = 191;

/** 超长 lastError 截到列长上限：保头（80 字符）+ 省略号 + 保尾（110 字符）——错误收尾最有诊断价值 */
export function clampLastError(message: string): string {
  const chars = [...message]; // 按代码点切，防劈裂代理对（emoji / 生僻字）
  if (chars.length <= LAST_ERROR_MAX_CODEPOINTS) return message;
  return `${chars.slice(0, 80).join("")}…${chars.slice(chars.length - 110).join("")}`;
}

export function createPrismaTranscodeJobStore(): TranscodeJobStore {
  const db = getDb<any>();

  return {
    async claim({ leaseMs, maxAttempts }) {
      const now = new Date();
      // 可认领 = 未终结 且（无 lease 或 lease 已过期）
      const claimable = { OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }] };
      const candidate = await db.transcodeJob.findFirst({
        where: { status: { in: ACTIVE_JOB_STATUSES }, ...claimable },
        orderBy: { createdAt: "asc" },
        select: { id: true, attempts: true, startedAt: true },
      });
      if (!candidate) return null;

      // 超过重试上限：直接判失败，避免死循环重派（ADR-0008 崩溃重派的安全阀）
      if (candidate.attempts >= maxAttempts) {
        await db.transcodeJob.update({
          where: { id: candidate.id },
          data: {
            status: "FAILED",
            lastError: clampLastError(`重试次数已达上限（${maxAttempts} 次）：worker 反复崩溃或任务本身不可完成`),
            finishedAt: now,
            leaseUntil: null,
          },
        });
        console.warn(`[worker] 任务 ${candidate.id} 超过重试上限，已置 FAILED`);
        return null;
      }

      const claimed = await db.transcodeJob.updateMany({
        where: { id: candidate.id, status: { in: ACTIVE_JOB_STATUSES }, ...claimable },
        data: {
          status: "PROBING",
          leaseUntil: new Date(now.getTime() + leaseMs),
          attempts: { increment: 1 },
          startedAt: candidate.startedAt ?? now,
          lastError: null,
          progress: null,
        },
      });
      if (claimed.count !== 1) return null; // 竞态：被其它实例抢走

      const row = await db.transcodeJob.findUnique({ where: { id: candidate.id } });
      return row ? toRow(row) : null;
    },

    async setStatus(id, status, patch) {
      await db.transcodeJob.update({
        where: { id },
        data: {
          status,
          ...(patch?.lastError !== undefined
            ? { lastError: patch.lastError == null ? null : clampLastError(patch.lastError) }
            : {}),
          ...(patch?.finishedAt !== undefined ? { finishedAt: patch.finishedAt } : {}),
          ...(patch?.leaseUntil !== undefined ? { leaseUntil: patch.leaseUntil } : {}),
          ...(patch?.progress !== undefined ? { progress: patch.progress } : {}),
        },
      });
    },

    async setProgress(id, progress) {
      const clamped = Math.max(0, Math.min(100, Math.round(progress)));
      await db.transcodeJob.update({ where: { id }, data: { progress: clamped } });
    },

    async extendLease(id, leaseMs) {
      await db.transcodeJob.update({
        where: { id },
        data: { leaseUntil: new Date(Date.now() + leaseMs) },
      });
    },
  };
}
