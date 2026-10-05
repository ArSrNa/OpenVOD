// 转码模板业务逻辑（ADR-0014：管理端 CRUD，Worker 消费；intent.md「转码模板管理」）
// 校验唯一真相源为 @openvod/contracts 的 zod schema（管理端与 Worker 共用）；
// keep_original = 只加密流程（不重编码，params 为 null）；encrypt=true 必须 HLS（应用层强制）；
// 可选关联一个水印模板（spec.md §10.4 / ADR-0018）：watermark_id 可空外键 + 两层校验之一。
import {
  CreateTranscodeTemplateRequest,
  TranscodeTemplateDTO,
  UpdateTranscodeTemplateRequest,
  z,
} from "@openvod/contracts";
import { getDb } from "@openvod/db";
import { NextResponse } from "next/server";
import { apiError } from "./api";
import { getWatermark, WatermarkError } from "./watermarks";

const db = getDb<any>();

/** 业务错误（code 对齐 @openvod/shared ERROR_CODES） */
export class TemplateError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

type TemplateRow = {
  id: string;
  name: string;
  description: string | null;
  keepOriginal: boolean;
  encrypt: boolean;
  format: string;
  params: unknown;
  isDefault: boolean;
  watermarkId: string | null;
  createdAt: Date;
  updatedAt: Date;
};

/** DB 行 → DTO（camelCase → snake_case；params JSON 透传，Worker 侧再校验） */
function toDto(row: TemplateRow): z.infer<typeof TranscodeTemplateDTO> {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    keep_original: row.keepOriginal,
    encrypt: row.encrypt,
    format: row.format as "HLS",
    params: (row.params ?? null) as z.infer<typeof TranscodeTemplateDTO>["params"],
    is_default: row.isDefault,
    watermark_id: row.watermarkId ?? null,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

/** zod 校验失败 → 400（取首条 issue，带字段路径） */
function firstIssue(error: z.ZodError): string {
  const issue = error.issues[0];
  const path = issue?.path?.length ? `${issue.path.join(".")}: ` : "";
  return `${path}${issue?.message ?? "请求体校验失败"}`;
}

function isUniqueViolation(e: unknown): boolean {
  return (e as { code?: string }).code === "P2002";
}
function isRecordNotFound(e: unknown): boolean {
  return (e as { code?: string }).code === "P2025";
}

/** encrypt=true 必须 HLS（ADR-0014 硬约束；v1 format 枚举仅 HLS，此处为演进兜底） */
function assertEncryptFormat(input: { encrypt: boolean; format: string }): void {
  if (input.encrypt && input.format !== "HLS") {
    throw new TemplateError("bad_request", "选择了加密时输出格式必须为 HLS", 400);
  }
}

/**
 * 水印关联的两层校验之一（模板保存侧，spec.md §10.4）：
 *   - keep_original（`-c copy` 不解码）不得关联水印；
 *   - 图片型水印必须已上传图片（image_key 缺失时烧录无从下手）。
 * 任务发起侧在 ./transcode-submit 再校验一次。
 */
async function assertWatermarkLink(watermarkId: string | null | undefined, keepOriginal: boolean): Promise<void> {
  if (watermarkId == null) return;
  if (keepOriginal) {
    throw new TemplateError(
      "bad_request",
      "「保持原视频配置」不重编码，无法烧录水印（请关闭保持原视频或取消水印关联）",
      400,
    );
  }
  let watermark: Awaited<ReturnType<typeof getWatermark>>;
  try {
    watermark = await getWatermark(watermarkId);
  } catch (e) {
    if (e instanceof WatermarkError) {
      throw new TemplateError("bad_request", e.message, e.status);
    }
    throw e;
  }
  if (watermark.type === "image" && !watermark.image_key) {
    throw new TemplateError("bad_request", `水印「${watermark.name}」尚未上传图片，无法关联`, 400);
  }
}

// ---- 列表（创建时间倒序） ----

export async function listTemplates(): Promise<{ total: number; items: z.infer<typeof TranscodeTemplateDTO>[] }> {
  const rows = await db.transcodeTemplate.findMany({ orderBy: { createdAt: "desc" } });
  return { total: rows.length, items: rows.map(toDto) };
}

export async function getTemplate(id: string): Promise<z.infer<typeof TranscodeTemplateDTO>> {
  const row = await db.transcodeTemplate.findUnique({ where: { id } });
  if (!row) throw new TemplateError("not_found", `模板不存在：${id}`, 404);
  return toDto(row);
}

// ---- 创建 ----

export async function createTemplate(
  body: unknown,
): Promise<z.infer<typeof TranscodeTemplateDTO>> {
  const parsed = CreateTranscodeTemplateRequest.safeParse(body);
  if (!parsed.success) {
    throw new TemplateError("bad_request", firstIssue(parsed.error), 400);
  }
  const input = parsed.data;
  assertEncryptFormat(input);
  await assertWatermarkLink(input.watermark_id, input.keep_original);
  try {
    const row = await db.transcodeTemplate.create({
      data: {
        name: input.name,
        description: input.description ?? null,
        keepOriginal: input.keep_original,
        encrypt: input.encrypt,
        format: input.format,
        // keep_original 只加密流程：不重编码，params 落 NULL
        params: input.keep_original ? null : input.params,
        isDefault: input.is_default,
        watermarkId: input.keep_original ? null : (input.watermark_id ?? null),
      },
    });
    return toDto(row);
  } catch (e) {
    if (isUniqueViolation(e)) {
      throw new TemplateError("bad_request", `模板名已存在：${input.name}`, 409);
    }
    throw new TemplateError("internal", `创建模板失败：${(e as Error).message}`, 500);
  }
}

// ---- 更新（部分字段；undefined 字段不动） ----

export async function updateTemplate(
  id: string,
  body: unknown,
): Promise<z.infer<typeof TranscodeTemplateDTO>> {
  const parsed = UpdateTranscodeTemplateRequest.safeParse(body);
  if (!parsed.success) {
    throw new TemplateError("bad_request", firstIssue(parsed.error), 400);
  }
  const input = parsed.data;
  const data: Record<string, unknown> = {};
  if (input.name !== undefined) data.name = input.name;
  if (input.description !== undefined) data.description = input.description ?? null;
  if (input.keep_original !== undefined) data.keepOriginal = input.keep_original;
  if (input.encrypt !== undefined) data.encrypt = input.encrypt;
  if (input.format !== undefined) data.format = input.format;
  if (input.is_default !== undefined) data.isDefault = input.is_default;
  if (input.params !== undefined) data.params = input.keep_original ? null : input.params;
  if (input.watermark_id !== undefined) data.watermarkId = input.watermark_id;
  // keep_original 翻转为 true 时清除重编码参数与水印关联；翻回 false 必须随请求提供 params（下方校验）

  const current = await db.transcodeTemplate
    .findUnique({ where: { id }, select: { keepOriginal: true, encrypt: true, format: true, watermarkId: true } })
    .catch(() => null);
  if (!current) throw new TemplateError("not_found", `模板不存在：${id}`, 404);
  assertEncryptFormat({
    encrypt: (input.encrypt ?? current.encrypt) as boolean,
    format: (input.format ?? current.format) as string,
  });
  if (input.keep_original === false && input.params === undefined && current.keepOriginal) {
    throw new TemplateError("bad_request", "从「保持原视频」切回转码模板必须同时提供 params", 400);
  }
  // 水印关联两层校验（模板保存侧）：keep_original 生效值 + 请求 / 既有 watermark_id 都要过
  const nextKeepOriginal = (input.keep_original ?? current.keepOriginal) as boolean;
  if (nextKeepOriginal && (input.watermark_id ?? current.watermarkId) != null) {
    throw new TemplateError(
      "bad_request",
      "「保持原视频配置」不重编码，无法烧录水印（请关闭保持原视频或取消水印关联）",
      400,
    );
  }
  await assertWatermarkLink(input.watermark_id ?? current.watermarkId, nextKeepOriginal);
  // 切到 keep_original 时水印关联必须一并清空（DB 列恒为 NULL 的不变式）
  if (nextKeepOriginal && input.watermark_id === undefined) data.watermarkId = null;

  try {
    const row = await db.transcodeTemplate.update({ where: { id }, data });
    return toDto(row);
  } catch (e) {
    if (isRecordNotFound(e)) {
      throw new TemplateError("not_found", `模板不存在：${id}`, 404);
    }
    if (isUniqueViolation(e)) {
      throw new TemplateError("bad_request", `模板名已存在：${input.name ?? ""}`, 409);
    }
    throw new TemplateError("internal", `更新模板失败：${(e as Error).message}`, 500);
  }
}

// ---- 删除（任务引用为 submit 时快照，无外键，可直接删；水印侧引用在 watermark_id 上，
//      删模板只会让该水印的 referenced_by 减少，不影响水印本身） ----

export async function deleteTemplate(id: string): Promise<{ id: string }> {
  try {
    await db.transcodeTemplate.delete({ where: { id } });
  } catch (e) {
    if (isRecordNotFound(e)) {
      throw new TemplateError("not_found", `模板不存在：${id}`, 404);
    }
    throw new TemplateError("internal", `删除模板失败：${(e as Error).message}`, 500);
  }
  return { id };
}

/** 业务错误 → 统一错误信封响应 */
export function templateErrorResponse(e: unknown): NextResponse {
  if (e instanceof TemplateError) return apiError(e.code, e.message, e.status);
  console.error("[templates] unexpected error:", e);
  return apiError("internal", (e as Error)?.message ?? "内部错误", 500);
}
