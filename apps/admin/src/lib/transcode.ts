// 转码任务业务逻辑（M2；ADR-0008 队列 / ADR-0014 模板快照）
// 发起时**只做校验与快照**，不生成 argv：源片分辨率 / 帧率未知，编译在 Worker 探测后完成（ADR-0014）。
import {
  TranscodeJobDTO,
  TranscodeSubmitRequest,
  TranscodeSubmitResponse,
  z,
} from "@openvod/contracts";
import { getDb } from "@openvod/db";
import { NextResponse } from "next/server";
import { apiError } from "./api";
import { assertMediaId, resolveOriginalKey } from "./media";
import { TemplateError, getTemplate } from "./templates";

const db = getDb<any>();

/** 未终结状态：同一媒资同时只允许一个进行中的任务（避免并发转码互相覆盖产物） */
const ACTIVE_JOB_STATUSES = ["QUEUED", "PROBING", "ENCODING", "PACKAGING"];

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
    last_error: row.lastError,
    created_at: row.createdAt.toISOString(),
    started_at: row.startedAt?.toISOString() ?? null,
    finished_at: row.finishedAt?.toISOString() ?? null,
  };
}

// ---- 发起转码（M2 入口） ----

export async function submitTranscode(
  mediaId: string,
  body: unknown,
): Promise<z.infer<typeof TranscodeSubmitResponse>> {
  assertMediaId(mediaId);

  const parsed = TranscodeSubmitRequest.safeParse(body);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new TranscodeError("bad_request", `${issue?.path.join(".") ?? ""} ${issue?.message ?? "请求体校验失败"}`, 400);
  }

  const media = await db.media
    .findUnique({ where: { id: mediaId }, select: { id: true, sourceKey: true } })
    .catch(() => null);
  if (!media) throw new TranscodeError("not_found", `媒资不存在：${mediaId}`, 404);
  const sourceKey = media.sourceKey ?? (await resolveOriginalKey(mediaId));
  if (!sourceKey) throw new TranscodeError("not_found", `媒资原始文件缺失，无法转码：${mediaId}`, 404);

  let template;
  try {
    template = await getTemplate(parsed.data.template_id);
  } catch (e) {
    if (e instanceof TemplateError) throw new TranscodeError(e.code, e.message, e.status);
    throw e;
  }
  // 非法组合双层校验（ADR-0014：模板保存与任务发起各拦一次）
  if (template.encrypt && template.format !== "HLS") {
    throw new TranscodeError("bad_request", "选择了加密时输出格式必须为 HLS", 400);
  }

  const running = await db.transcodeJob.findFirst({
    where: { mediaId, status: { in: ACTIVE_JOB_STATUSES } },
    select: { id: true },
  });
  if (running) {
    throw new TranscodeError(
      "bad_request",
      `该媒资已有进行中的转码任务（${running.id}），请等待其完成或失败后再发起`,
      409,
    );
  }

  const job = await db.transcodeJob.create({
    data: {
      mediaId,
      status: "QUEUED",
      templateId: template.id,
      // 模板快照（ADR-0014 防漂移）：Worker 只吃快照，模板后续改删不影响本任务
      templateSnapshot: {
        template_id: template.id,
        name: template.name,
        keep_original: template.keep_original,
        encrypt: template.encrypt,
        format: template.format,
        params: template.params,
      },
    },
  });

  return { job_id: job.id, status: "QUEUED" };
}

// ---- 任务列表（管理端「转码任务」页） ----

export async function listTranscodeJobs(limit = 200): Promise<{
  total: number;
  items: z.infer<typeof TranscodeJobDTO>[];
}> {
  const rows: JobRow[] = await db.transcodeJob.findMany({
    orderBy: { createdAt: "desc" },
    take: limit,
  });
  const mediaIds = [...new Set(rows.map((r) => r.mediaId))];
  const medias: Array<{ id: string; title: string }> = mediaIds.length
    ? await db.media.findMany({ where: { id: { in: mediaIds } }, select: { id: true, title: true } })
    : [];
  const titleOf = new Map(medias.map((m) => [m.id, m.title]));
  return { total: rows.length, items: rows.map((row) => toDto(row, titleOf.get(row.mediaId) ?? null)) };
}

/** 业务错误 → 统一错误信封响应 */
export function transcodeErrorResponse(e: unknown): NextResponse {
  if (e instanceof TranscodeError) return apiError(e.code, e.message, e.status);
  console.error("[transcode] unexpected error:", e);
  return apiError("internal", (e as Error)?.message ?? "内部错误", 500);
}
