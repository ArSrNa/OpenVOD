// 转码任务业务逻辑（M2；ADR-0008 队列 / ADR-0014 模板快照）
// 发起时**只做校验与快照**，不生成 argv：源片分辨率 / 帧率未知，编译在 Worker 探测后完成（ADR-0014）。
// 单次可**多选**模板（编排核心见 ./transcode-submit，依赖注入便于单测）：每个模板各入队一条任务，
// 产物各落 proceed/{mediaId}/{templateId}/（spec.md §1.3）。
import {
  ACTIVE_JOB_STATUSES,
  TranscodeJobDTO,
  TranscodeSubmitResponse,
  z,
  type DashboardStats,
} from "@openvod/contracts";
import { getDb } from "@openvod/db";
import { NextResponse } from "next/server";
import { apiError } from "./api";
import { assertMediaId, resolveOriginalKey } from "./media";
import { getTemplate } from "./templates";
import { getWatermark } from "./watermarks";
import { jobActionState } from "./job-actions";
import { submitTranscodeWithDeps, TranscodeSubmitError, type SubmitJobRow } from "./transcode-submit";

const db = getDb<any>();

// 未终结状态（ACTIVE_JOB_STATUSES）唯一真相源在 @openvod/contracts：
// 同一媒资 + **同一模板** 同时只允许一个进行中的任务；产物按 `proceed/{mediaId}/{templateId}/` 分树存放，
// 不同模板互不覆盖，故同媒资不同模板可并行（spec.md §5.1）。

export class TranscodeError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

type JobRow = {
  id: string;
  mediaId: string;
  status: string;
  templateId: string | null;
  templateSnapshot: unknown;
  attempts: number;
  /** 当前阶段进度（0–100；DOWNLOADING / ENCODING 阶段有意义，其余为 null） */
  progress: number | null;
  /** worker 执行租约到期时间（认领时写入、执行期心跳续期；null = 未被认领） */
  leaseUntil: Date | null;
  /** 取消请求时间（执行中的任务由 worker 轮询到后立即中断并置 CANCELLED） */
  cancelRequestedAt: Date | null;
  lastError: string | null;
  createdAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
};

function snapshotName(snapshot: unknown): string | null {
  const name = (snapshot as { name?: unknown } | null)?.name;
  return typeof name === "string" ? name : null;
}

function toDto(row: JobRow, mediaTitle: string | null): z.infer<typeof TranscodeJobDTO> {
  return {
    id: row.id,
    media_id: row.mediaId,
    media_title: mediaTitle,
    status: row.status as z.infer<typeof TranscodeJobDTO>["status"],
    template_id: row.templateId,
    template_name: snapshotName(row.templateSnapshot),
    attempts: row.attempts,
    progress: row.progress,
    lease_active: row.leaseUntil ? row.leaseUntil.getTime() > Date.now() : false,
    cancel_requested_at: row.cancelRequestedAt?.toISOString() ?? null,
    last_error: row.lastError,
    created_at: row.createdAt.toISOString(),
    started_at: row.startedAt?.toISOString() ?? null,
    finished_at: row.finishedAt?.toISOString() ?? null,
  };
}

// ---- 发起转码（M2 入口；单次可多选模板，ADR-0014） ----
// 编排逻辑在 ./transcode-submit（依赖注入纯函数）；此处只做真实依赖装配 + 错误类型转换。
export async function submitTranscode(
  mediaId: string,
  body: unknown,
): Promise<z.infer<typeof TranscodeSubmitResponse>> {
  try {
    return await submitTranscodeWithDeps(mediaId, body, {
      assertMediaId,
      findMedia: (id) =>
        db.media.findUnique({ where: { id }, select: { id: true, sourceKey: true } }).catch(() => null),
      resolveOriginalKey,
      getTemplate,
      // 水印快照来源（spec.md §10.4）：模板关联的水印模板内容随任务固化，Worker 只读快照
      getWatermark,
      listActiveJobs: (id) =>
        db.transcodeJob.findMany({
          where: { mediaId: id, status: { in: ACTIVE_JOB_STATUSES } },
          select: { id: true, templateId: true },
        }),
      // 每个模板各入队一条任务；整批同一事务内创建
      createJobs: (rows: SubmitJobRow[]) =>
        db.$transaction(rows.map((data) => db.transcodeJob.create({ data }))),
    });
  } catch (e) {
    if (e instanceof TranscodeSubmitError) throw new TranscodeError(e.code, e.message, e.status);
    throw e;
  }
}

// ---- 任务列表（管理端「转码任务」页） ----

export async function listTranscodeJobs(limit = 200): Promise<{
  total: number;
  items: z.infer<typeof TranscodeJobDTO>[];
}> {
  const rows: JobRow[] = await db.transcodeJob.findMany({
    // 排序必须稳定：同事务批量入队的任务 createdAt 常同毫秒，缺 tiebreaker 会让顺序漂移，
    // 被 SSE 变化指纹误判为「有变化」（详见 lib/jobs-stream）
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit,
  });
  const mediaIds = [...new Set(rows.map((r) => r.mediaId))];
  const medias: Array<{ id: string; title: string }> = mediaIds.length
    ? await db.media.findMany({ where: { id: { in: mediaIds } }, select: { id: true, title: true } })
    : [];
  const titleOf = new Map(medias.map((m) => [m.id, m.title]));
  return { total: rows.length, items: rows.map((row) => toDto(row, titleOf.get(row.mediaId) ?? null)) };
}

// ---- 总览统计（intent.md「控制台总览」）：按状态聚合未终结任务（spec.md §5.1 状态机） ----

export type ActiveJobStats = DashboardStats["jobs"];

/** 各未终结状态一次 COUNT（DB 侧聚合，不拉取任务行） */
export async function getActiveJobStats(): Promise<ActiveJobStats> {
  const [queued, probing, downloading, encoding, packaging] = await Promise.all(
    ACTIVE_JOB_STATUSES.map((status) => db.transcodeJob.count({ where: { status } })),
  );
  return {
    active: queued + probing + downloading + encoding + packaging,
    queued,
    probing,
    downloading,
    encoding,
    packaging,
  };
}

// ---- 取消 / 重启（任务页操作；语义见 spec.md §5.1） ----

export interface StopJobResult {
  id: string;
  /** 当前状态：cancelling=true 时仍是执行中的状态（等待 worker 收尾），收尾后为 CANCELLED */
  status: z.infer<typeof TranscodeJobDTO>["status"];
  /** true = 已提交取消请求，worker 正在中断（状态列显示「取消中」）；false = 已立即终结 */
  cancelling: boolean;
}

/**
 * 取消（立即打断，2026-11-12）：
 *   - QUEUED：直接置 CANCELLED，撤下队列，永不被认领；
 *   - 执行中且租约有效：写 `cancel_requested_at`——worker 每 2s 轮询，命中即杀 ffmpeg / 中止拉源，
 *     随后把状态落为 CANCELLED（写库守卫保证完成态不会覆盖已取消）；
 *   - 执行中但租约已过期（worker 失联 / 已死）：直接置 CANCELLED 收尾。
 * 写入均用 CAS（状态未变才生效），与 worker 的完成写竞态时让用户刷新重试。
 */
export async function stopTranscodeJob(id: string): Promise<StopJobResult> {
  const row = await db.transcodeJob.findUnique({ where: { id } }).catch(() => null);
  if (!row) throw new TranscodeError("not_found", `任务不存在：${id}`, 404);
  const leaseActive = row.leaseUntil ? row.leaseUntil.getTime() > Date.now() : false;
  const state = jobActionState({
    status: row.status,
    leaseActive,
    cancelRequested: row.cancelRequestedAt != null,
  });
  if (!state.canStop) {
    throw new TranscodeError("bad_request", state.stopBlocked ?? "该任务当前不可取消", 409);
  }

  if (leaseActive) {
    // 执行中：不动 status（worker 仍持有租约），只写取消请求位，由 worker 中断并收尾
    const requested = await db.transcodeJob.updateMany({
      where: { id, status: row.status, cancelRequestedAt: null },
      data: { cancelRequestedAt: new Date() },
    });
    if (requested.count === 0) {
      throw new TranscodeError("bad_request", "任务状态刚刚发生变化，请刷新后重试", 409);
    }
    return { id, status: row.status as StopJobResult["status"], cancelling: true };
  }

  const updated = await db.transcodeJob.updateMany({
    where: { id, status: row.status },
    data: {
      status: "CANCELLED",
      lastError: null,
      leaseUntil: null,
      cancelRequestedAt: row.cancelRequestedAt ?? new Date(),
      finishedAt: new Date(),
      progress: null,
    },
  });
  if (updated.count === 0) {
    throw new TranscodeError("bad_request", "任务状态刚刚发生变化，请刷新后重试", 409);
  }
  return { id, status: "CANCELLED", cancelling: false };
}

/**
 * 重启（重新入队）：仅 FAILED（失败）或 CANCELLED（管理端取消）。
 * attempts 必须清零——否则认领逻辑会立即判「超过重试上限」而秒失败（worker job-store.claim）；
 * cancel_requested_at 必须清空——否则 worker 认领后会立刻再次收到取消。
 */
export async function restartTranscodeJob(id: string): Promise<{ id: string; status: "QUEUED" }> {
  const row = await db.transcodeJob.findUnique({ where: { id } }).catch(() => null);
  if (!row) throw new TranscodeError("not_found", `任务不存在：${id}`, 404);
  const state = jobActionState({ status: row.status, leaseActive: false });
  if (!state.canRestart) {
    throw new TranscodeError("bad_request", state.restartBlocked ?? "该任务当前不可重启", 409);
  }
  const updated = await db.transcodeJob.updateMany({
    where: { id, status: { in: ["FAILED", "CANCELLED"] } },
    data: {
      status: "QUEUED",
      attempts: 0,
      lastError: null,
      leaseUntil: null,
      cancelRequestedAt: null,
      startedAt: null,
      finishedAt: null,
    },
  });
  if (updated.count === 0) {
    throw new TranscodeError("bad_request", "任务状态刚刚发生变化，请刷新后重试", 409);
  }
  return { id, status: "QUEUED" };
}

/** 业务错误 → 统一错误信封响应 */
export function transcodeErrorResponse(e: unknown): NextResponse {
  if (e instanceof TranscodeError) return apiError(e.code, e.message, e.status);
  console.error("[transcode] unexpected error:", e);
  return apiError("internal", (e as Error)?.message ?? "内部错误", 500);
}
