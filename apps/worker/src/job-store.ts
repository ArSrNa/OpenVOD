// 转码任务认领与状态机（ADR-0008：不引入 Redis，靠 DB 认领 + lease 崩溃重派）
//
// 认领用 **CAS 条件更新**（updateMany + 状态/lease 过滤）：MySQL 与 SQLite 语义一致，
// 多实例并发时也只有一个能成功（count=1）。ADR-0008 提到 MySQL 的 `FOR UPDATE SKIP LOCKED`
// 作为高并发演进项——CAS 已保证不重复认领，只是并发吞吐略低，故 v1 不做方言分支。
// lease 过期即视为 worker 崩溃，任务可被重新认领，attempts 递增；超过上限判失败。
import { JOB_STATUSES } from "@openvod/contracts";
import { getDb } from "@openvod/db";

export type JobStatusName = (typeof JOB_STATUSES)[number];

/** 未终结状态：处于这些状态且 lease 已过期的任务可被重新认领 */
export const ACTIVE_JOB_STATUSES: JobStatusName[] = ["QUEUED", "PROBING", "ENCODING", "PACKAGING"];

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
    patch?: { lastError?: string | null; finishedAt?: Date | null; leaseUntil?: Date | null },
  ): Promise<void>;
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
            lastError: `重试次数已达上限（${maxAttempts} 次）：worker 反复崩溃或任务本身不可完成`,
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
          ...(patch?.lastError !== undefined ? { lastError: patch.lastError } : {}),
          ...(patch?.finishedAt !== undefined ? { finishedAt: patch.finishedAt } : {}),
          ...(patch?.leaseUntil !== undefined ? { leaseUntil: patch.leaseUntil } : {}),
        },
      });
    },

    async extendLease(id, leaseMs) {
      await db.transcodeJob.update({
        where: { id },
        data: { leaseUntil: new Date(Date.now() + leaseMs) },
      });
    },
  };
}
