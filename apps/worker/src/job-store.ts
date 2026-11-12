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
  /**
   * 定向认领指定任务（invoked 模式，ADR-0017 修订）：唤醒载荷已带 jobId，不做队列扫描；
   * 语义与 claim 完全一致（CAS + lease + attempts 上限），重复投递时只有一次能抢到。
   */
  claimById(id: string, opts: { leaseMs: number; maxAttempts: number }): Promise<TranscodeJobRow | null>;
  setStatus(
    id: string,
    status: JobStatusName,
    patch?: { lastError?: string | null; finishedAt?: Date | null; leaseUntil?: Date | null; progress?: number | null },
  ): Promise<void>;
  /** 阶段进度上报（0–100；DOWNLOADING / ENCODING 阶段有意义，其余阶段清空） */
  setProgress(id: string, progress: number): Promise<void>;
  /** 执行期心跳续期（长转码任务不被重派） */
  extendLease(id: string, leaseMs: number): Promise<void>;
  /** 是否已请求取消（管理端写 cancel_requested_at，或已被置 CANCELLED）；执行期轮询此接口 */
  isCancelRequested(id: string): Promise<boolean>;
  /** 覆盖写任务日志尾部（有界环形文本），返回新版本号 log_seq（每次写入 +1） */
  writeLog(id: string, tail: string): Promise<number>;
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

  /**
   * CAS 认领（claim / claimById 共用）：`filter` 为空 = 队列模式（按 createdAt 取最早一条），
   * 带 `id` = invoked 模式定向认领（ADR-0017 修订）。条件更新语义完全一致，
   * 平台重投 / 并发唤醒时只有一次能抢到。
   */
  async function claimWhere(
    filter: Record<string, unknown>,
    { leaseMs, maxAttempts }: { leaseMs: number; maxAttempts: number },
  ): Promise<TranscodeJobRow | null> {
    // 取消收尾可能让首轮候选作废，故循环若干轮再判定「队列空」
    for (let round = 0; round < 5; round++) {
      const now = new Date();
      // 可认领 = 未终结 且（无 lease 或 lease 已过期）
      const claimable = { OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }] };
      const candidate = await db.transcodeJob.findFirst({
        where: { ...filter, status: { in: ACTIVE_JOB_STATUSES }, ...claimable },
        orderBy: { createdAt: "asc" },
        select: { id: true, attempts: true, startedAt: true, cancelRequestedAt: true },
      });
      if (!candidate) return null;

      // 取消请求只在原 worker 失联（租约过期）后才被这里看到：不再执行，直接收尾为 CANCELLED
      if (candidate.cancelRequestedAt) {
        const settled = await db.transcodeJob.updateMany({
          where: { ...filter, id: candidate.id, status: { in: ACTIVE_JOB_STATUSES }, ...claimable },
          data: { status: "CANCELLED", leaseUntil: null, finishedAt: now, progress: null, lastError: null },
        });
        if (settled.count === 1) {
          console.log(`[worker] 任务 ${candidate.id} 的取消请求已生效（原 worker 已失联），置 CANCELLED`);
        }
        continue;
      }

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
        where: { ...filter, id: candidate.id, status: { in: ACTIVE_JOB_STATUSES }, ...claimable },
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

      const row = await db.transcodeJob.findUnique({
        where: { id: candidate.id },
        // 显式 select：log_tail 是 48KB 的诊断数据，认领路径不需要
        select: {
          id: true,
          mediaId: true,
          status: true,
          templateId: true,
          templateSnapshot: true,
          attempts: true,
          startedAt: true,
        },
      });
      return row ? toRow(row) : null;
    }
    return null;
  }

  return {
    claim: (opts) => claimWhere({}, opts),
    claimById: (id, opts) => claimWhere({ id }, opts),

    // 取消是终结态：所有执行期写入都带 `status != CANCELLED` 守卫，
    // 避免管理端已取消后 worker 的完成 / 进度 / 续租写把任务「复活」（spec.md §5.1）。
    async setStatus(id, status, patch) {
      await db.transcodeJob.updateMany({
        where: { id, status: { not: "CANCELLED" } },
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
      await db.transcodeJob.updateMany({
        where: { id, status: { not: "CANCELLED" } },
        data: { progress: clamped },
      });
    },

    async extendLease(id, leaseMs) {
      await db.transcodeJob.updateMany({
        where: { id, status: { not: "CANCELLED" } },
        data: { leaseUntil: new Date(Date.now() + leaseMs) },
      });
    },

    async isCancelRequested(id) {
      const row = await db.transcodeJob.findUnique({
        where: { id },
        select: { status: true, cancelRequestedAt: true },
      });
      return Boolean(row && (row.status === "CANCELLED" || row.cancelRequestedAt));
    },

    // 日志不是事实源：只覆盖有界尾部并推进版本号，不追加行、不参与状态机；
    // 取消 / 失败后仍可覆盖（诊断价值高于「终结态不可变」），故不带 status 守卫。
    async writeLog(id, tail) {
      const row = await db.transcodeJob.update({
        where: { id },
        data: { logTail: tail, logSeq: { increment: 1 } },
        select: { logSeq: true },
      });
      return row.logSeq;
    },
  };
}
