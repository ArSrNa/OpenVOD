// 媒资管理业务逻辑（M1 竖切 + M2 转码产物归组；spec.md §1/§2）
// 存储视角与数据库视角合并：媒资集合以 original/ 分区为准（spec.md §1.4），
// 数据库行补充展示名（title，可重命名）与生命周期状态。
// 转码产物按 `proceed/{id}/{模板id}/` 分组展示（spec.md §1.3），模板名来自 transcode_templates；
// 元数据探测（ffprobe）见 lib/probe.ts。
import {
  MEDIA_ID_CHARS,
  MEDIA_ID_PATTERN,
  STORAGE_KEYS,
  STORAGE_PARTITIONS,
  TEMPLATE_ID_PATTERN,
  generateMediaId,
  resolveMediaIdLength,
} from "@openvod/shared";
import {
  PRODUCT_LEGACY_ID,
  countSubtitlesByMedia,
  groupProductsByMedia,
  selectProductObjectKeys,
  type MediaProduct,
} from "./media-products";
import { getDb } from "@openvod/db";
import { NextResponse } from "next/server";
import { getStorage } from "./storage";
import { apiError } from "./api";

const db = getDb<any>();

/** 业务错误（code 对齐 @openvod/shared ERROR_CODES） */
export class MediaError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

// original/{id}.{ext}：媒资唯一确定对象（spec.md §1.3）
const ORIGINAL_RE = new RegExp(
  `^${STORAGE_PARTITIONS.original}/(${MEDIA_ID_CHARS})\\.([a-z0-9]{1,10})$`,
  "i",
);
const COVER_EXTS = new Set(["jpg", "jpeg", "png", "webp", "gif", "avif"]);

export function assertMediaId(id: string): string {
  if (!MEDIA_ID_PATTERN.test(id)) {
    throw new MediaError("not_found", `媒资不存在：${id}`, 404);
  }
  return id;
}

/** 从文件名提取并清洗扩展名（仅允许字母数字 ≤10 位，防路径注入） */
function sanitizeExt(filename: string): string | null {
  const m = /\.([a-z0-9]{1,10})$/i.exec(filename.trim());
  return m ? m[1].toLowerCase() : null;
}

function contentTypeFor(ext: string): string {
  switch (ext) {
    case "mp4":
    case "m4v":
      return "video/mp4";
    case "webm":
      return "video/webm";
    case "mkv":
      return "video/x-matroska";
    case "mov":
      return "video/quicktime";
    case "ts":
    case "m2ts":
      return "video/mp2t";
    case "avi":
      return "video/x-msvideo";
    case "flv":
      return "video/x-flv";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "png":
      return "image/png";
    case "webp":
      return "image/webp";
    case "gif":
      return "image/gif";
    case "avif":
      return "image/avif";
    default:
      return "application/octet-stream";
  }
}

export { contentTypeFor };

function isUniqueViolation(e: unknown): boolean {
  return (e as { code?: string }).code === "P2002";
}
function isRecordNotFound(e: unknown): boolean {
  return (e as { code?: string }).code === "P2025";
}

// ---- 上传（原视频入库；spec.md §1.3：生成数字 ID → original/{id}.{ext}，ID 落库） ----

export interface UploadResult {
  id: string;
  title: string;
  ext: string;
  /** original 相对键 */
  key: string;
  size: number;
}

export async function uploadOriginal(input: {
  filename: string;
  title?: string | null;
  body: ReadableStream;
}): Promise<UploadResult> {
  const ext = sanitizeExt(input.filename);
  if (!ext) {
    throw new MediaError("bad_request", `无法从文件名识别扩展名：${input.filename}`, 400);
  }
  const storage = getStorage();
  const idLen = resolveMediaIdLength(process.env.MEDIA_ID_LENGTH);
  const title =
    (input.title ?? "").trim() || input.filename.replace(/\.[^.]+$/, "").trim();

  // 先落库占位（主键唯一性冲突即重取 ID，spec.md §1.3），再流式写存储；存储失败回滚 DB 行
  for (let attempt = 0; attempt < 5; attempt++) {
    const id = generateMediaId(idLen);
    const key = STORAGE_KEYS.original(id, ext);
    const displayName = title || id;
    try {
      await db.media.create({
        data: { id, title: displayName, status: "UPLOADED", sourceKey: key },
      });
    } catch (e) {
      if (isUniqueViolation(e)) continue; // ID 冲突：重取（spec.md §1.3）
      throw new MediaError("internal", `数据库写入失败：${(e as Error).message}`, 500);
    }
    try {
      await storage.putStream(key, input.body, contentTypeFor(ext));
    } catch (e) {
      await db.media.delete({ where: { id } }).catch(() => {}); // 回滚占位行
      throw new MediaError("internal", `对象存储写入失败：${(e as Error).message}`, 500);
    }
    const stat = await storage.stat(key);
    return { id, title: displayName, ext, key, size: stat?.size ?? 0 };
  }
  throw new MediaError("internal", "媒资 ID 冲突重试次数过多，请重试", 500);
}

// ---- 转码产物按模板归组（spec.md §1.3：proceed/{媒资id}/{模板id}/…） ----
// 纯函数在 lib/media-products.ts（不碰 DB，便于单测）；这里只负责补模板名。

/** 批量补模板名（transcode_templates）；查询失败降级为 null，不影响列表可用性 */
async function attachTemplateNames(products: MediaProduct[]): Promise<void> {
  const ids = [...new Set(products.map((p) => p.templateId).filter(Boolean))];
  if (!ids.length) return;
  const rows: Array<{ id: string; name: string }> = await db.transcodeTemplate
    .findMany({ where: { id: { in: ids } }, select: { id: true, name: true } })
    .catch(() => []);
  const nameById = new Map(rows.map((r) => [r.id, r.name]));
  for (const p of products) {
    if (p.templateId) p.templateName = nameById.get(p.templateId) ?? null;
  }
}

// ---- 列表（存储视角 + DB 合并；spec.md §1.4） ----

export interface MediaRow {
  id: string;
  /** 展示名（数据库；重命名只改这里，不动 original 文件名与媒资 ID） */
  title: string | null;
  /** 生命周期状态（数据库；无 DB 行为 null） */
  status: string | null;
  /** 封面对象键（数据库 posterKey；列表首列缩略图展示用） */
  posterKey: string | null;
  ext: string;
  key: string;
  size: number;
  lastModified?: string;
  assets: { proceed: number; cover: number; metadata: number };
  /** 转码产物按模板分组（spec.md §1.3）；空数组 = 尚无转码产物 */
  products: MediaProduct[];
  /** 该媒资的字幕对象数（`proceed/{id}/subtitles/*.vtt`，spec.md §7.2；字幕管理页选择器用） */
  subtitleCount: number;
}

export async function listMedia(): Promise<{ total: number; items: MediaRow[] }> {
  const storage = getStorage();
  type MediaDbRow = { id: string; title: string; status: string; posterKey: string | null };
  // DB 查询失败时降级为纯存储视角（title/status 置 null），保证列表可用
  const rowsTask: Promise<MediaDbRow[]> = db.media
    .findMany({ select: { id: true, title: true, status: true, posterKey: true } })
    .catch(() => [] as MediaDbRow[]);
  const [originals, proceeds, covers, metadatas, rows] = await Promise.all([
    storage.listObjects(`${STORAGE_PARTITIONS.original}/`),
    storage.listObjects(`${STORAGE_PARTITIONS.proceed}/`),
    storage.listObjects(`${STORAGE_PARTITIONS.cover}/`),
    storage.listObjects(`${STORAGE_PARTITIONS.metadata}/`),
    rowsTask,
  ]);
  const rowMap = new Map<string, MediaDbRow>(rows.map((r) => [r.id, r]));

  const countUnder = (objs: { key: string }[], partition: string): Map<string, number> => {
    const re = new RegExp(`^${partition}/(${MEDIA_ID_CHARS})/`);
    const counts = new Map<string, number>();
    for (const o of objs) {
      const m = re.exec(o.key);
      if (m) counts.set(m[1], (counts.get(m[1]) ?? 0) + 1);
    }
    return counts;
  };
  const proceedCounts = countUnder(proceeds, STORAGE_PARTITIONS.proceed);
  const coverCounts = countUnder(covers, STORAGE_PARTITIONS.cover);
  const metadataCounts = countUnder(metadatas, STORAGE_PARTITIONS.metadata);
  const productsByMedia = groupProductsByMedia(proceeds);
  const subtitleCounts = countSubtitlesByMedia(proceeds); // 保留段：字幕不计入 products（spec.md §7.2）
  await attachTemplateNames([...productsByMedia.values()].flat());

  const items: MediaRow[] = [];
  for (const o of originals) {
    const m = ORIGINAL_RE.exec(o.key);
    if (!m) continue; // spec.md §1.4：非数字文件名 / 异常层级不属于媒资，忽略
    const row = rowMap.get(m[1]);
    items.push({
      id: m[1],
      title: row?.title ?? null,
      status: row?.status ?? null,
      posterKey: row?.posterKey ?? null,
      ext: m[2].toLowerCase(),
      key: o.key,
      size: o.size,
      lastModified: o.lastModified?.toISOString(),
      assets: {
        proceed: proceedCounts.get(m[1]) ?? 0,
        cover: coverCounts.get(m[1]) ?? 0,
        metadata: metadataCounts.get(m[1]) ?? 0,
      },
      products: productsByMedia.get(m[1]) ?? [],
      subtitleCount: subtitleCounts.get(m[1]) ?? 0,
    });
  }
  items.sort((a, b) => Number(b.id) - Number(a.id)); // 数值语义降序（新媒资在前）
  return { total: items.length, items };
}

// ---- 总览统计（intent.md「控制台总览」；spec.md §1.4 媒资集合定义） ----

export interface MediaStats {
  /** 媒资总数：以 original/ 分区为准（不依赖 DB 行是否存在） */
  total: number;
  /** 已入库且状态为 READY 的媒资数 */
  ready: number;
  /** 有 original 对象但无数据库行（历史 / 降级数据），列表展示为「未入库」 */
  not_ingested: number;
}

/**
 * 只列举 original/ 一个分区 + 两次 DB 计数（比 listMedia 轻量：不触碰 proceed/cover/metadata）。
 * 计数以 original 的媒资集合为准，DB 行只补充状态，与媒资列表口径一致。
 */
export async function getMediaStats(): Promise<MediaStats> {
  const storage = getStorage();
  const originals = await storage.listObjects(`${STORAGE_PARTITIONS.original}/`);
  const ids: string[] = [];
  for (const o of originals) {
    const m = ORIGINAL_RE.exec(o.key);
    if (m) ids.push(m[1]); // 非数字文件名 / 异常层级不属于媒资（spec.md §1.4）
  }
  const [ingested, ready] = await Promise.all([
    db.media.count({ where: { id: { in: ids } } }),
    db.media.count({ where: { id: { in: ids }, status: "READY" } }),
  ]);
  return { total: ids.length, ready, not_ingested: ids.length - ingested };
}

// ---- 详情（弹窗展示媒资元数据；probe 等转码侧字段当前为 null，ADR-0008 TODO） ----

export interface MediaDetail {
  id: string;
  title: string | null;
  status: string | null;
  ext: string | null;
  size: number | null;
  lastModified: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  /** ffprobe 系统元数据（转码流水线写入，未实现时为 null） */
  probe: unknown;
  /** 业务自定义数据 */
  customData: unknown;
  durationMs: number | null;
  posterKey: string | null;
  sourceKey: string | null;
  assets: { proceed: number; cover: number; metadata: number };
  /** 转码产物按模板分组（spec.md §1.3） */
  products: MediaProduct[];
}

export async function getMediaDetail(id: string): Promise<MediaDetail> {
  assertMediaId(id);
  const storage = getStorage();
  const [originals, proceeds, covers, metadatas, row] = await Promise.all([
    storage.listObjects(`${STORAGE_PARTITIONS.original}/`),
    storage.listObjects(`${STORAGE_PARTITIONS.proceed}/${id}/`),
    storage.listObjects(`${STORAGE_PARTITIONS.cover}/${id}/`),
    storage.listObjects(`${STORAGE_PARTITIONS.metadata}/${id}/`),
    db.media.findUnique({ where: { id } }).catch(() => null),
  ]);
  const original = originals.find((o) => ORIGINAL_RE.exec(o.key)?.[1] === id);
  const ext = original ? ORIGINAL_RE.exec(original.key)?.[2]?.toLowerCase() ?? null : null;
  const products = groupProductsByMedia(proceeds).get(id) ?? [];
  await attachTemplateNames(products);
  return {
    id,
    title: row?.title ?? null,
    status: row?.status ?? null,
    ext,
    size: original?.size ?? null,
    lastModified: original?.lastModified?.toISOString() ?? null,
    createdAt: row?.createdAt?.toISOString() ?? null,
    updatedAt: row?.updatedAt?.toISOString() ?? null,
    probe: row?.probe ?? null,
    customData: row?.customData ?? null,
    durationMs: row?.durationMs ?? null,
    posterKey: row?.posterKey ?? null,
    sourceKey: row?.sourceKey ?? original?.key ?? null,
    assets: { proceed: proceeds.length, cover: covers.length, metadata: metadatas.length },
    products,
  };
}

// ---- 重命名（仅改数据库展示名；original 文件名与媒资 ID 永不改变，intent.md） ----

export async function renameMedia(
  id: string,
  title: string,
): Promise<{ id: string; title: string }> {
  assertMediaId(id);
  const t = title.trim();
  if (!t) throw new MediaError("bad_request", "展示名不能为空", 400);
  if (t.length > 191) throw new MediaError("bad_request", "展示名过长（≤191 字符）", 400);
  try {
    return await db.media.update({
      where: { id },
      data: { title: t },
      select: { id: true, title: true },
    });
  } catch (e) {
    if (isRecordNotFound(e)) {
      throw new MediaError("not_found", `媒资不存在或未入库：${id}`, 404);
    }
    throw new MediaError("internal", `重命名失败：${(e as Error).message}`, 500);
  }
}

// ---- 删除（存储四分区该 id 全部对象 + DB 行；spec.md §2 级联范围注记） ----

async function findOriginalKey(id: string): Promise<string | null> {
  const originals = await getStorage().listObjects(`${STORAGE_PARTITIONS.original}/`);
  return originals.find((o) => ORIGINAL_RE.exec(o.key)?.[1] === id)?.key ?? null;
}

export async function deleteMedia(id: string): Promise<{ removed: boolean }> {
  assertMediaId(id);
  const storage = getStorage();
  const row = await db.media
    .findUnique({ where: { id }, select: { sourceKey: true } })
    .catch(() => null);

  // 存储侧先删（DELETE 幂等，失败可整体重试；DB-only 残行不影响列表展示，spec.md §1.4）
  const originalKey = row?.sourceKey ?? (await findOriginalKey(id));
  if (originalKey) await storage.delete(originalKey);
  for (const partition of [
    STORAGE_PARTITIONS.proceed,
    STORAGE_PARTITIONS.cover,
    STORAGE_PARTITIONS.metadata,
  ]) {
    const objs = await storage.listObjects(`${partition}/${id}/`);
    await Promise.all(objs.map((o) => storage.delete(o.key)));
  }
  // 数据库行（级联 subtitles / transcode_jobs / hls_keys / playback_sessions，onDelete: Cascade）
  let removed = Boolean(originalKey);
  try {
    await db.media.delete({ where: { id } });
    removed = true;
  } catch (e) {
    if (!isRecordNotFound(e)) {
      throw new MediaError("internal", `数据库删除失败：${(e as Error).message}`, 500);
    }
  }
  return { removed };
}

// ---- 删除某套转码产物（proceed/{id}/{模板id}/ 子树；spec.md §1.3/§5.5） ----

/** 未终结任务状态（与 spec.md §5.1 状态机一致；此处独立常量避免与 transcode.ts 循环引用） */
const ACTIVE_JOB_STATUSES = ["QUEUED", "PROBING", "ENCODING", "PACKAGING"] as const;

/**
 * 删除一份模板产物（按模板粒度，不动其它模板子树）：
 *   - 只删存储对象：`hls_keys`（每媒资一份，可能被其它模板产物共用）与 `transcode_jobs` 历史一律保留；
 *   - 同媒资同模板存在未终结任务时拒绝（Worker 上传与删除会互相打架，spec.md §5.1）；
 *   - 旧布局（无模板段）用 PRODUCT_LEGACY_ID 触发，只删散落在 `proceed/{id}/` 顶层、非保留段的对象。
 */
export async function deleteMediaProduct(
  id: string,
  templateId: string,
): Promise<{ deleted: number; bytes: number }> {
  assertMediaId(id);
  const tpl = templateId === PRODUCT_LEGACY_ID ? "" : templateId;
  if (tpl && !TEMPLATE_ID_PATTERN.test(tpl)) {
    throw new MediaError("bad_request", `模板 ID 形状非法：${templateId}`, 400);
  }
  if (tpl) {
    const active = await db.transcodeJob
      .findFirst({
        where: { mediaId: id, templateId: tpl, status: { in: [...ACTIVE_JOB_STATUSES] } },
        select: { id: true },
      })
      .catch(() => null);
    if (active) {
      throw new MediaError(
        "bad_request",
        `该模板存在进行中的转码任务（${active.id}），请等待其完成或失败后再删除产物`,
        409,
      );
    }
  }
  const storage = getStorage();
  const objs = await storage.listObjects(`${STORAGE_PARTITIONS.proceed}/${id}/`);
  const targets = selectProductObjectKeys(objs, id, tpl);
  if (!targets.length) {
    throw new MediaError("not_found", "该产物不存在或已被删除", 404);
  }
  await Promise.all(targets.map((o) => storage.delete(o.key)));
  return { deleted: targets.length, bytes: targets.reduce((sum, o) => sum + o.size, 0) };
}

// ---- 封面（上传到 cover/{id}/poster.{ext} 并回写 DB posterKey） ----

export async function uploadCover(
  id: string,
  filename: string,
  body: ReadableStream,
): Promise<{ key: string }> {
  assertMediaId(id);
  const ext = sanitizeExt(filename);
  if (!ext || !COVER_EXTS.has(ext)) {
    throw new MediaError("bad_request", "封面仅支持图片格式（jpg/png/webp/gif/avif）", 400);
  }
  const storage = getStorage();
  const row = await db.media
    .findUnique({ where: { id }, select: { id: true } })
    .catch(() => null);
  if (!row) throw new MediaError("not_found", `媒资不存在或未入库：${id}`, 404);
  const norm = ext === "jpeg" ? "jpg" : ext;
  const key = STORAGE_KEYS.coverPoster(id, norm);
  try {
    await storage.putStream(key, body, contentTypeFor(norm));
  } catch (e) {
    throw new MediaError("internal", `对象存储写入失败：${(e as Error).message}`, 500);
  }
  try {
    await db.media.update({ where: { id }, data: { posterKey: key } });
  } catch (e) {
    if (isRecordNotFound(e)) {
      throw new MediaError("not_found", `媒资不存在或未入库：${id}`, 404);
    }
    throw new MediaError("internal", `数据库更新失败：${(e as Error).message}`, 500);
  }
  return { key };
}

// ---- 原视频定位（预览用） ----

/** 解析媒资 original 对象键：优先 DB sourceKey，兜底存储按 id 过滤 */
export async function resolveOriginalKey(id: string): Promise<string | null> {
  assertMediaId(id);
  const row = await db.media
    .findUnique({ where: { id }, select: { sourceKey: true } })
    .catch(() => null);
  if (row?.sourceKey) return row.sourceKey;
  return findOriginalKey(id);
}

// ---- 封面定位（列表 / 详情展示用；GET /api/admin/media/{id}/cover） ----

/** 解析媒资 poster 对象键：优先 DB posterKey，兜底存储 cover/{id}/ 下 poster.* 过滤 */
export async function resolvePosterKey(id: string): Promise<string | null> {
  assertMediaId(id);
  const row = await db.media
    .findUnique({ where: { id }, select: { posterKey: true } })
    .catch(() => null);
  if (row?.posterKey) return row.posterKey;
  const covers = await getStorage().listObjects(`${STORAGE_PARTITIONS.cover}/${id}/`);
  return covers.find((o) => /\/poster\.[a-z0-9]+$/i.test(o.key))?.key ?? null;
}

/** 业务错误 → 统一错误信封响应 */
export function mediaErrorResponse(e: unknown): NextResponse {
  if (e instanceof MediaError) return apiError(e.code, e.message, e.status);
  console.error("[media] unexpected error:", e);
  return apiError("internal", (e as Error)?.message ?? "内部错误", 500);
}
