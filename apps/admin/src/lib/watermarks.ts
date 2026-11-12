// 水印模板业务逻辑（spec.md §10 / ADR-0018：管理端 CRUD + 图片资产上传 + 被转码模板引用的统计与删除保护）
// 校验唯一真相源为 @openvod/contracts 的 zod schema（WatermarkParams 含 type 字面量自描述）；
// 图片落 watermark/{模板ID}.{ext}（平台级模板资产分区，spec.md §10.2），宽高由 ffprobe 探测回填。
import {
  CreateWatermarkRequest,
  UpdateWatermarkRequest,
  WatermarkParams,
  WatermarkTemplateDTO,
  z,
} from "@openvod/contracts";
import { getDb } from "@openvod/db";
import {
  STORAGE_KEYS,
  STORAGE_PARTITIONS,
  WATERMARK_ID_PATTERN,
  WATERMARK_IMAGE_MAX_BYTES,
} from "@openvod/shared";
import { ffprobeJSON } from "@openvod/transcode";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NextResponse } from "next/server";
import { apiError } from "./api";
import { getStorage } from "./storage";
import { FFPROBE_HINT, probeFFprobeAvailability } from "./ffprobe-env";
import { detectImageFormat, WATERMARK_IMAGE_CONTENT_TYPES, WATERMARK_IMAGE_EXTS } from "./watermark-image";

const db = getDb<any>();

/** 业务错误（code 对齐 @openvod/shared ERROR_CODES） */
export class WatermarkError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

type WatermarkRow = {
  id: string;
  name: string;
  description: string | null;
  type: "image" | "text";
  imageExt: string | null;
  imageKey: string | null;
  imageBytes: number | null;
  imageWidth: number | null;
  imageHeight: number | null;
  params: unknown;
  createdAt: Date;
  updatedAt: Date;
};

function assertWatermarkId(id: string): string {
  if (!WATERMARK_ID_PATTERN.test(id)) {
    throw new WatermarkError("not_found", `水印模板不存在：${id}`, 404);
  }
  return id;
}

/** DB 行 → DTO（camelCase → snake_case；params JSON 已在写入时校验，透传） */
function toDto(row: WatermarkRow, referencedBy = 0): z.infer<typeof WatermarkTemplateDTO> {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    type: row.type,
    params: row.params as z.infer<typeof WatermarkTemplateDTO>["params"],
    image_ext: row.imageExt,
    image_key: row.imageKey,
    image_bytes: row.imageBytes,
    image_width: row.imageWidth,
    image_height: row.imageHeight,
    // spec.md §10.3：text 恒 ready；image 型 missing = 尚未上传图片（不可被转码模板关联）
    image_status: row.type === "text" || row.imageKey ? "ready" : "missing",
    referenced_by: referencedBy,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

/**
 * 一次 groupBy 统计各水印被引用的转码模板数（spec.md §10.3 `referenced_by`）。
 * 引用关系在 transcode_templates.watermark_id 上，非列表请求可跳过。
 */
async function referencedCounts(ids: string[]): Promise<Map<string, number>> {
  if (!ids.length) return new Map();
  const rows = await db.transcodeTemplate
    .groupBy({ by: ["watermarkId"], where: { watermarkId: { in: ids } }, _count: { _all: true } })
    .catch(() => []);
  const out = new Map<string, number>();
  for (const row of rows as Array<{ watermarkId: string | null; _count: { _all: number } }>) {
    if (row.watermarkId) out.set(row.watermarkId, row._count._all);
  }
  return out;
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

// ---- 列表（创建时间倒序） ----

export async function listWatermarks(): Promise<{ total: number; items: z.infer<typeof WatermarkTemplateDTO>[] }> {
  const rows = await db.watermarkTemplate.findMany({ orderBy: { createdAt: "desc" } });
  const counts = await referencedCounts(rows.map((r: WatermarkRow) => r.id));
  return {
    total: rows.length,
    items: rows.map((row: WatermarkRow) => toDto(row, counts.get(row.id) ?? 0)),
  };
}

export async function getWatermark(id: string): Promise<z.infer<typeof WatermarkTemplateDTO>> {
  assertWatermarkId(id);
  const row = await db.watermarkTemplate.findUnique({ where: { id } });
  if (!row) throw new WatermarkError("not_found", `水印模板不存在：${id}`, 404);
  const counts = await referencedCounts([id]);
  return toDto(row, counts.get(id) ?? 0);
}

// ---- 创建 ----

export async function createWatermark(
  body: unknown,
): Promise<z.infer<typeof WatermarkTemplateDTO>> {
  const parsed = CreateWatermarkRequest.safeParse(body);
  if (!parsed.success) {
    throw new WatermarkError("bad_request", firstIssue(parsed.error), 400);
  }
  const input = parsed.data;
  try {
    const row = await db.watermarkTemplate.create({
      data: {
        name: input.name,
        description: input.description ?? null,
        type: input.params.type,
        params: input.params,
      },
    });
    return toDto(row);
  } catch (e) {
    if (isUniqueViolation(e)) {
      throw new WatermarkError("bad_request", `模板名已存在：${input.name}`, 409);
    }
    throw new WatermarkError("internal", `创建水印模板失败：${(e as Error).message}`, 500);
  }
}

// ---- 更新（部分字段；type 不可改，params.type 必须与既有模板一致） ----

export async function updateWatermark(
  id: string,
  body: unknown,
): Promise<z.infer<typeof WatermarkTemplateDTO>> {
  assertWatermarkId(id);
  const parsed = UpdateWatermarkRequest.safeParse(body);
  if (!parsed.success) {
    throw new WatermarkError("bad_request", firstIssue(parsed.error), 400);
  }
  const input = parsed.data;
  const current = await db.watermarkTemplate
    .findUnique({ where: { id } })
    .catch(() => null);
  if (!current) throw new WatermarkError("not_found", `水印模板不存在：${id}`, 404);
  if (input.params !== undefined && input.params.type !== current.type) {
    throw new WatermarkError("bad_request", "水印模板类型不可更改", 400);
  }
  const data: Record<string, unknown> = {};
  if (input.name !== undefined) data.name = input.name;
  if (input.description !== undefined) data.description = input.description ?? null;
  if (input.params !== undefined) data.params = input.params;
  try {
    const row = await db.watermarkTemplate.update({ where: { id }, data });
    return toDto(row);
  } catch (e) {
    if (isRecordNotFound(e)) {
      throw new WatermarkError("not_found", `水印模板不存在：${id}`, 404);
    }
    if (isUniqueViolation(e)) {
      throw new WatermarkError("bad_request", `模板名已存在：${input.name ?? ""}`, 409);
    }
    throw new WatermarkError("internal", `更新水印模板失败：${(e as Error).message}`, 500);
  }
}

// ---- 删除（先删 watermark/ 下该模板全部对象、再删 DB 行；幂等可重试，spec.md §10.2） ----

export async function deleteWatermark(id: string): Promise<{ id: string; removed_objects: number }> {
  assertWatermarkId(id);
  const row = await db.watermarkTemplate.findUnique({ where: { id } }).catch(() => null);
  if (!row) throw new WatermarkError("not_found", `水印模板不存在：${id}`, 404);
  // 删除保护（spec.md §10.2）：被任一转码模板引用 → 409，要求先解除引用。
  // 已入队 / 已完成任务不受影响（快照自包含）；DB 侧还有 watermark_id SetNull 兜底。
  const counts = await referencedCounts([id]);
  const referencedBy = counts.get(id) ?? 0;
  if (referencedBy > 0) {
    throw new WatermarkError(
      "bad_request",
      `水印模板正被 ${referencedBy} 个转码模板引用，请先在转码模板中解除关联后再删除`,
      409,
    );
  }
  const storage = await getStorage();
  const objects = await storage
    .listObjects(`${STORAGE_PARTITIONS.watermark}/`)
    .then((objs) => objs.filter((o) => o.key.startsWith(`watermark/${id}.`)))
    .catch(() => []);
  await Promise.all(objects.map((o) => storage.delete(o.key)));
  try {
    await db.watermarkTemplate.delete({ where: { id } });
  } catch (e) {
    if (isRecordNotFound(e)) {
      throw new WatermarkError("not_found", `水印模板不存在：${id}`, 404);
    }
    throw new WatermarkError("internal", `删除水印模板失败：${(e as Error).message}`, 500);
  }
  return { id, removed_objects: objects.length };
}

// ---- 图片资产（spec.md §10.2：覆盖式 PUT 同一键；宽高 ffprobe 探测回填） ----

/**
 * 上传 / 替换图片水印图：内容识别格式（png / jpg / webp）→ ffprobe 探测宽高（临时文件，
 * 损坏文件在此 400 暴露）→ 覆盖写对象 → 扩展名变化时清理旧对象 → 回填 image_* 列。
 */
export async function uploadWatermarkImage(
  id: string,
  bytes: Uint8Array,
): Promise<z.infer<typeof WatermarkTemplateDTO>> {
  assertWatermarkId(id);
  const row = await db.watermarkTemplate.findUnique({ where: { id } }).catch(() => null);
  if (!row) throw new WatermarkError("not_found", `水印模板不存在：${id}`, 404);
  if (row.type !== "image") {
    throw new WatermarkError("bad_request", "文字水印模板没有图片资产", 400);
  }
  if (bytes.length === 0) {
    throw new WatermarkError("bad_request", "请求体为空（应携带图片字节流）", 400);
  }
  if (bytes.length > WATERMARK_IMAGE_MAX_BYTES) {
    throw new WatermarkError("bad_request", "水印图片超过 2 MiB 上限", 400);
  }
  const format = detectImageFormat(bytes);
  if (!format) {
    throw new WatermarkError("bad_request", "仅支持 PNG / JPG / WebP 图片（按文件内容识别，与扩展名无关）", 400);
  }
  const ext = WATERMARK_IMAGE_EXTS[format];
  const contentType = WATERMARK_IMAGE_CONTENT_TYPES[format];
  // 宽高只能靠 ffprobe 探测：运行环境缺它属于**服务端**故障（500），不能退化成「图片损坏」（400）
  const reason = await probeFFprobeAvailability();
  if (reason) {
    throw new WatermarkError("internal", `运行环境无法执行 ffprobe，无法解析图片尺寸：${reason}（${FFPROBE_HINT}）`, 500);
  }
  const dims = await probeImageDimensions(bytes, ext);
  const key = STORAGE_KEYS.watermark(id, ext);
  const storage = await getStorage();
  try {
    await storage.put(key, bytes, contentType);
  } catch (e) {
    throw new WatermarkError("internal", `对象存储写入失败：${(e as Error).message}`, 500);
  }
  // 扩展名变化（如 png 换 webp）时清理旧对象，避免 watermark/ 残留不可达键
  if (row.imageKey && row.imageKey !== key) {
    await storage.delete(row.imageKey).catch(() => undefined);
  }
  try {
    const updated = await db.watermarkTemplate.update({
      where: { id },
      data: {
        imageExt: ext,
        imageKey: key,
        imageBytes: bytes.length,
        imageWidth: dims.width,
        imageHeight: dims.height,
      },
    });
    return toDto(updated);
  } catch (e) {
    if (isRecordNotFound(e)) {
      throw new WatermarkError("not_found", `水印模板不存在：${id}`, 404);
    }
    throw new WatermarkError("internal", `数据库更新失败：${(e as Error).message}`, 500);
  }
}

/** 图片定位（预览 302 用）：仅图片型且已上传；文字型 / 缺图 → null */
export async function resolveWatermarkImageKey(id: string): Promise<string | null> {
  assertWatermarkId(id);
  const row = await db.watermarkTemplate
    .findUnique({ where: { id }, select: { type: true, imageKey: true } })
    .catch(() => null);
  if (!row || row.type !== "image" || !row.imageKey) return null;
  return row.imageKey;
}

/** ffprobe 探测图片像素宽高（spec.md §10.2）：写临时文件探测后清理；损坏 / 非图文件抛错 → 400 */
async function probeImageDimensions(bytes: Uint8Array, ext: string): Promise<{ width: number; height: number }> {
  const dir = await mkdtemp(join(tmpdir(), "openvod-watermark-"));
  const file = join(dir, `watermark.${ext}`);
  await writeFile(file, bytes);
  try {
    const probe = await ffprobeJSON(file, 30_000);
    const stream = (probe.streams ?? []).find((s) => s.codec_type === "video");
    const width = stream?.width;
    const height = stream?.height;
    if (!width || !height) {
      throw new WatermarkError("bad_request", "无法解析图片尺寸（文件可能损坏或不是有效图片）", 400);
    }
    return { width, height };
  } catch (e) {
    if (e instanceof WatermarkError) throw e;
    throw new WatermarkError("bad_request", "无法解析图片尺寸（文件可能损坏或不是有效图片）", 400);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** 业务错误 → 统一错误信封响应 */
export function watermarkErrorResponse(e: unknown): NextResponse {
  if (e instanceof WatermarkError) return apiError(e.code, e.message, e.status);
  console.error("[watermarks] unexpected error:", e);
  return apiError("internal", (e as Error)?.message ?? "内部错误", 500);
}

/** 请求体 → WatermarkParams（校验失败抛 400；供路由层复用） */
export function parseWatermarkParams(body: unknown): z.infer<typeof WatermarkParams> {
  const parsed = WatermarkParams.safeParse(body);
  if (!parsed.success) {
    throw new WatermarkError("bad_request", firstIssue(parsed.error), 400);
  }
  return parsed.data;
}
