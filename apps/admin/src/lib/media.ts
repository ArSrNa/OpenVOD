// 媒资管理业务逻辑（M1 竖切 + M2 转码产物归组；spec.md §1/§2）
// 存储视角与数据库视角合并：媒资集合以 original/ 分区为准（spec.md §1.4），
// 数据库行补充展示名（title，可重命名）与生命周期状态。
// 转码产物按 `proceed/{id}/{模板id}/` 分组展示（spec.md §1.3），模板名来自 transcode_templates；
// 元数据探测（ffprobe）见 lib/probe.ts。
import {
  MEDIA_CATEGORY_ID_PATTERN,
  MEDIA_CATEGORY_SORT_MAX,
  MEDIA_DEFAULT_CATEGORY_DESCRIPTION,
  MEDIA_DEFAULT_CATEGORY_ID,
  MEDIA_DEFAULT_CATEGORY_NAME,
  MEDIA_ID_CHARS,
  MEDIA_ID_PATTERN,
  STORAGE_KEYS,
  STORAGE_PARTITIONS,
  TEMPLATE_ID_PATTERN,
  generateMediaId,
  normalizeMediaTags,
  type MediaCustomCategory,
} from "@openvod/shared";
import {
  PRODUCT_LEGACY_ID,
  countSubtitlesByMedia,
  groupProductsByMedia,
  selectProductObjectKeys,
  type MediaProduct,
} from "./media-products";
import {
  parseMediaProductSettings,
  serializeMediaProductSettings,
  visibleProducts,
} from "./media-product-settings";
import {
  buildCategoryLookup,
  categoryRefById,
  pickCategoryRef,
  type CategoryLookup,
  type CategoryNode,
} from "./category-tree";
import { mergeCustomData, parseMediaTags, serializeCustomData } from "./custom-metadata";
import { getDb } from "@openvod/db";
import { ACTIVE_JOB_STATUSES } from "@openvod/contracts";
import type {
  DashboardStats,
  MediaCustomMetadataDTO,
  MediaProductSettingsDTO,
} from "@openvod/contracts";
import type { z } from "@openvod/contracts";
import type { StorageObject } from "@openvod/storage";
import { NextResponse } from "next/server";
import { getStorage } from "./storage";
import { getSettingsSnapshot } from "./settings";
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
  const storage = await getStorage();
  // ADR-0015：媒资 ID 位数从 system_settings 解析（DB > env MEDIA_ID_LENGTH > 默认 8）
  const idLen = (await getSettingsSnapshot()).admin.mediaIdLength;
  const title =
    (input.title ?? "").trim() || input.filename.replace(/\.[^.]+$/, "").trim();

  // 新媒资默认归入系统默认分类「其他」（spec.md §8.1 修订）：未设置分类的媒资即「其他」，
  // 因此上传时就把 category_id 与自定义元数据投影一起写好（分发端读投影，不留空）
  const defaultCategory = pickCategoryRef(await loadCategoryLookup(), null);

  // 先落库占位（主键唯一性冲突即重取 ID，spec.md §1.3），再流式写存储；存储失败回滚 DB 行
  for (let attempt = 0; attempt < 5; attempt++) {
    const id = generateMediaId(idLen);
    const key = STORAGE_KEYS.original(id, ext);
    const displayName = title || id;
    const customData = mergeCustomData(null, {
      category: defaultCategory,
      description: null,
      tags: [],
    });
    try {
      await db.media.create({
        data: {
          id,
          title: displayName,
          status: "UPLOADED",
          sourceKey: key,
          categoryId: defaultCategory?.id ?? null,
          customData,
        },
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
    // 投影导出（`metadata/{id}/custom.json`）：best-effort，失败只告警（spec.md §8.3）
    try {
      await storage.put(STORAGE_KEYS.metadataCustom(id), serializeCustomData(customData), "application/json");
    } catch (e) {
      console.warn(`[media] custom.json 导出失败（${id}）：${(e as Error).message}`);
    }
    const stat = await storage.stat(key);
    return { id, title: displayName, ext, key, size: stat?.size ?? 0 };
  }
  throw new MediaError("internal", "媒资 ID 冲突重试次数过多，请重试", 500);
}

// ---- 前端直传（ADR-0005 上传路径：预签名 PUT，字节不经过管理端） ----
// 三步：init（生成 ID + 占位行 + 预签名 URL）→ 浏览器 PUT 到对象存储 → complete（校验对象 + 投影导出）。
// 取消 / 失败调 abort 丢弃占位行与残留对象；complete 之前的媒资不在列表里（列表以 original/ 对象为准，§1.4）。

/** 预签名 PUT 有效期（秒）：覆盖单个大文件的上传耗时；过期由前端重新发起（新任务） */
export const UPLOAD_PRESIGN_TTL_SEC = 6 * 60 * 60;

export interface BeginUploadResult {
  id: string;
  title: string;
  ext: string;
  /** original 相对键（不含全局 root 前缀） */
  key: string;
  /** 预签名 PUT URL（上传预签名恒走存储端点，不经 CDN，ADR-0005） */
  uploadUrl: string;
  /** URL 过期时刻（ISO 8601） */
  expiresAt: string;
}

/** 开启直传：生成媒资 ID（主键冲突即重取，spec.md §1.3）→ 占位行 → 预签名 PUT URL */
export async function beginUpload(input: {
  filename: string;
  title?: string | null;
}): Promise<BeginUploadResult> {
  const ext = sanitizeExt(input.filename);
  if (!ext) {
    throw new MediaError("bad_request", `无法从文件名识别扩展名：${input.filename}`, 400);
  }
  const storage = await getStorage();
  // ADR-0015：媒资 ID 位数从 system_settings 解析（DB > env MEDIA_ID_LENGTH > 默认 8）
  const idLen = (await getSettingsSnapshot()).admin.mediaIdLength;
  const title = (input.title ?? "").trim() || input.filename.replace(/\.[^.]+$/, "").trim();
  // 新媒资默认归入系统默认分类「其他」（spec.md §8.1 修订）：占位行即写好分类与投影
  const defaultCategory = pickCategoryRef(await loadCategoryLookup(), null);

  for (let attempt = 0; attempt < 5; attempt++) {
    const id = generateMediaId(idLen);
    const key = STORAGE_KEYS.original(id, ext);
    const displayName = title || id;
    const customData = mergeCustomData(null, {
      category: defaultCategory,
      description: null,
      tags: [],
    });
    try {
      await db.media.create({
        data: {
          id,
          title: displayName,
          status: "UPLOADED",
          sourceKey: key,
          categoryId: defaultCategory?.id ?? null,
          customData,
        },
      });
    } catch (e) {
      if (isUniqueViolation(e)) continue; // ID 冲突：重取（spec.md §1.3）
      throw new MediaError("internal", `数据库写入失败：${(e as Error).message}`, 500);
    }
    try {
      const uploadUrl = await storage.presignPut(key, UPLOAD_PRESIGN_TTL_SEC);
      return {
        id,
        title: displayName,
        ext,
        key,
        uploadUrl,
        expiresAt: new Date(Date.now() + UPLOAD_PRESIGN_TTL_SEC * 1000).toISOString(),
      };
    } catch (e) {
      await db.media.delete({ where: { id } }).catch(() => {}); // 回滚占位行
      throw new MediaError("internal", `预签名生成失败：${(e as Error).message}`, 500);
    }
  }
  throw new MediaError("internal", "媒资 ID 冲突重试次数过多，请重试", 500);
}

/** 完成直传：确认对象已写入（HEAD）→ 导出 custom.json（best-effort，spec.md §8.3） */
export async function completeUpload(id: string): Promise<UploadResult> {
  assertMediaId(id);
  const row = await db.media
    .findUnique({
      where: { id },
      select: { id: true, title: true, sourceKey: true, customData: true },
    })
    .catch(() => null);
  if (!row?.sourceKey) {
    throw new MediaError("not_found", `媒资不存在或未入库：${id}`, 404);
  }
  const storage = await getStorage();
  // 对象没到 = 上传没成功（中断 / 未发起）；占位行留着无意义，交给 abort 清理
  const stat = await storage.stat(row.sourceKey);
  if (!stat) {
    throw new MediaError("bad_request", "文件未上传完成，请重试", 409);
  }
  try {
    await storage.put(
      STORAGE_KEYS.metadataCustom(id),
      serializeCustomData(row.customData),
      "application/json",
    );
  } catch (e) {
    console.warn(`[media] custom.json 导出失败（${id}）：${(e as Error).message}`);
  }
  return {
    id,
    title: row.title,
    ext: ORIGINAL_RE.exec(row.sourceKey)?.[2]?.toLowerCase() ?? "",
    key: row.sourceKey,
    size: stat.size,
  };
}

/**
 * 丢弃直传占位：删残留对象 + DB 行（取消 / 失败 / 过期）。
 * 已产生转码产物则拒绝（409）——此时媒资已真正成立，删除走 DELETE /api/admin/media/{id}。
 */
export async function abortUpload(id: string): Promise<{ aborted: boolean }> {
  assertMediaId(id);
  const row = await db.media
    .findUnique({ where: { id }, select: { sourceKey: true } })
    .catch(() => null);
  if (!row) return { aborted: false };
  const storage = await getStorage().catch(() => null);
  if (storage) {
    const proceeds = await storage
      .listObjects(`${STORAGE_PARTITIONS.proceed}/${id}/`)
      .catch(() => []);
    if (proceeds.length) {
      throw new MediaError("bad_request", "该媒资已开始转码，请改用删除媒资", 409);
    }
  }
  if (storage && row.sourceKey) {
    await storage.delete(row.sourceKey).catch(() => {}); // 残留对象（含未完成分片）删除失败不阻断
  }
  await db.media.delete({ where: { id } }).catch(() => {});
  return { aborted: true };
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

// ---- 分类读取与默认分类（spec.md §8.1；分类 CRUD 见 lib/categories.ts） ----

/** 一次性取全部分类（分类表规模小；列表 / 详情 / 投影共用；查询失败降级为空 → 一律显示未分类） */
async function loadCategoryNodes(): Promise<CategoryNode[]> {
  return await db.mediaCategory
    .findMany({ select: { id: true, name: true, parentId: true, sortOrder: true } })
    .catch(() => [] as CategoryNode[]);
}

/**
 * 幂等确保系统默认分类「其他」存在（spec.md §8.1 修订 2026-09-24）：
 * MySQL 由迁移插入；SQLite 开发库（`db push`，无种子）与历史库靠这里补齐，
 * 冲突（并发创建 / 迁移已插入）时重读。创建失败降级为 null（读路径不阻断）。
 */
export async function ensureDefaultCategory(): Promise<{ id: string; name: string } | null> {
  const existing = await db.mediaCategory
    .findFirst({ where: { isSystem: true }, select: { id: true, name: true } })
    .catch(() => null);
  if (existing) return existing;
  try {
    return await db.mediaCategory.create({
      data: {
        id: MEDIA_DEFAULT_CATEGORY_ID,
        name: MEDIA_DEFAULT_CATEGORY_NAME,
        description: MEDIA_DEFAULT_CATEGORY_DESCRIPTION,
        parentId: null,
        // 默认排在顶级末尾（sort_order 越小越靠前）
        sortOrder: MEDIA_CATEGORY_SORT_MAX,
        isSystem: true,
      },
      select: { id: true, name: true },
    });
  } catch (e) {
    const again = await db.mediaCategory
      .findFirst({ where: { isSystem: true }, select: { id: true, name: true } })
      .catch(() => null);
    if (again) return again;
    console.warn(
      `[media] 默认分类「${MEDIA_DEFAULT_CATEGORY_NAME}」创建失败：${(e as Error).message}`,
    );
    return null;
  }
}

/** 分类解析表：确保默认分类 → 全部分类 → 路径表（列表 / 详情 / 投影共用） */
async function loadCategoryLookup(): Promise<CategoryLookup> {
  const [defaultCategory, nodes] = await Promise.all([ensureDefaultCategory(), loadCategoryNodes()]);
  return buildCategoryLookup(nodes, defaultCategory?.id ?? null);
}

/** 写入路径（严格）：分类不存在 / 形状非法直接报错（spec.md §8.2；**不做默认回退**） */
async function requireCategoryRef(categoryId: string): Promise<MediaCustomCategory> {
  if (!MEDIA_CATEGORY_ID_PATTERN.test(categoryId)) {
    throw new MediaError("bad_request", `分类 ID 形状非法：${categoryId}`, 400);
  }
  const ref = categoryRefById(await loadCategoryLookup(), categoryId);
  if (!ref) throw new MediaError("not_found", `分类不存在：${categoryId}`, 404);
  return ref;
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
  /** 归属分类（含路径快照；未分类 / 未入库为 null，spec.md §8） */
  category: MediaCustomCategory | null;
  /** 业务描述（spec.md §8） */
  description: string | null;
  /** 业务标签（spec.md §8） */
  tags: string[];
  ext: string;
  key: string;
  size: number;
  lastModified?: string;
  /** 自定义上传时间（数据库 uploaded_at；null = 未自定义，展示回退 lastModified，spec.md §3.1） */
  uploadedAt?: string | null;
  assets: { proceed: number; cover: number; metadata: number };
  /** 转码产物按模板分组（spec.md §1.3）；空数组 = 尚无转码产物 */
  products: MediaProduct[];
  /** 该媒资的字幕对象数（`proceed/{id}/subtitles/*.vtt`，spec.md §7.2；字幕管理页选择器用） */
  subtitleCount: number;
}

export async function listMedia(): Promise<{ total: number; items: MediaRow[] }> {
  const storage = await getStorage();
  type MediaDbRow = {
    id: string;
    title: string;
    status: string;
    posterKey: string | null;
    categoryId: string | null;
    description: string | null;
    tags: unknown;
    uploadedAt: Date | null;
  };
  // DB 查询失败时降级为纯存储视角（title/status 置 null），保证列表可用
  const rowsTask: Promise<MediaDbRow[]> = db.media
    .findMany({
      select: {
        id: true,
        title: true,
        status: true,
        posterKey: true,
        categoryId: true,
        description: true,
        tags: true,
        uploadedAt: true,
      },
    })
    .catch(() => [] as MediaDbRow[]);
  const [originals, proceeds, covers, metadatas, rows, categoryLookup] = await Promise.all([
    storage.listObjects(`${STORAGE_PARTITIONS.original}/`),
    storage.listObjects(`${STORAGE_PARTITIONS.proceed}/`),
    storage.listObjects(`${STORAGE_PARTITIONS.cover}/`),
    storage.listObjects(`${STORAGE_PARTITIONS.metadata}/`),
    rowsTask,
    loadCategoryLookup(),
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
      uploadedAt: row?.uploadedAt?.toISOString() ?? null,
      status: row?.status ?? null,
      posterKey: row?.posterKey ?? null,
      // 未设置分类 → 回退系统默认分类「其他」（spec.md §8.1 修订）
      category: pickCategoryRef(categoryLookup, row?.categoryId ?? null),
      description: row?.description ?? null,
      tags: parseMediaTags(row?.tags),
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

export type MediaStats = DashboardStats["media"];

/**
 * 只列举 original/ 一个分区（总览可传入已有列表）+ 两次 DB 计数。
 * 计数以 original 的媒资集合为准，DB 行只补充状态，与媒资列表口径一致。
 */
export async function getMediaStats(originals?: StorageObject[]): Promise<MediaStats> {
  originals ??= await (await getStorage()).listObjects(`${STORAGE_PARTITIONS.original}/`);
  const mediaIds = new Set<string>();
  for (const o of originals) {
    const m = ORIGINAL_RE.exec(o.key);
    if (m) mediaIds.add(m[1]); // 同一媒资不同扩展名也只计一次；非数字文件名 / 异常层级忽略
  }
  const ids = [...mediaIds];
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
  /** 自定义上传时间（null = 未自定义；管理端展示回退 lastModified，spec.md §3.1） */
  uploadedAt: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  /** ffprobe 系统元数据（转码流水线写入，未实现时为 null） */
  probe: unknown;
  /** 自定义元数据（**恒三项**：分类 / 描述 / 标签，空值 null / null / []，便于表单回填；spec.md §8.3） */
  custom: z.infer<typeof MediaCustomMetadataDTO>;
  /** 自定义元数据投影原文（**稀疏** JSON；= metadata/{id}/custom.json 的内容） */
  customData: unknown;
  durationMs: number | null;
  posterKey: string | null;
  sourceKey: string | null;
  assets: { proceed: number; cover: number; metadata: number };
  /** 转码产物按模板分组（spec.md §1.3）；每项带播放端展示 / 默认标记（spec.md §6.3） */
  products: MediaProduct[];
  /** 媒资级产物展示与默认设置（spec.md §6.3/§11.1） */
  productSettings: z.infer<typeof MediaProductSettingsDTO>;
}

export async function getMediaDetail(id: string): Promise<MediaDetail> {
  assertMediaId(id);
  const storage = await getStorage();
  const [originals, proceeds, covers, metadatas, row, categoryLookup] = await Promise.all([
    storage.listObjects(`${STORAGE_PARTITIONS.original}/`),
    storage.listObjects(`${STORAGE_PARTITIONS.proceed}/${id}/`),
    storage.listObjects(`${STORAGE_PARTITIONS.cover}/${id}/`),
    storage.listObjects(`${STORAGE_PARTITIONS.metadata}/${id}/`),
    db.media.findUnique({ where: { id } }).catch(() => null),
    loadCategoryLookup(),
  ]);
  const original = originals.find((o) => ORIGINAL_RE.exec(o.key)?.[1] === id);
  const ext = original ? ORIGINAL_RE.exec(original.key)?.[2]?.toLowerCase() ?? null : null;
  const products = groupProductsByMedia(proceeds).get(id) ?? [];
  await attachTemplateNames(products);

  // 播放端展示 / 默认标记（spec.md §6.3）：旧布局产物不参与（SDK 的 templates[] 不含它）
  const settings = parseMediaProductSettings(row?.productSettings);
  const allTemplateIds = products.map((p) => p.templateId).filter(Boolean);
  // 默认产物已被删（历史设置残留）：界面按「未设置默认」展示，与实际播放行为一致
  if (settings.defaultTemplateId && !allTemplateIds.includes(settings.defaultTemplateId)) {
    settings.defaultTemplateId = null;
  }
  const visibleIds = visibleProducts(settings, allTemplateIds);
  for (const p of products) {
    p.isVisible = p.templateId ? visibleIds.includes(p.templateId) : false;
    p.isDefault = p.templateId !== "" && p.templateId === settings.defaultTemplateId;
  }

  return {
    id,
    title: row?.title ?? null,
    status: row?.status ?? null,
    ext,
    size: original?.size ?? null,
    lastModified: original?.lastModified?.toISOString() ?? null,
    uploadedAt: row?.uploadedAt?.toISOString() ?? null,
    createdAt: row?.createdAt?.toISOString() ?? null,
    updatedAt: row?.updatedAt?.toISOString() ?? null,
    probe: row?.probe ?? null,
    custom: {
      // 未设置分类 → 回退系统默认分类「其他」（spec.md §8.1 修订）
      category: pickCategoryRef(categoryLookup, row?.categoryId ?? null),
      description: row?.description ?? null,
      tags: parseMediaTags(row?.tags),
    },
    customData: row?.customData ?? null,
    durationMs: row?.durationMs ?? null,
    posterKey: row?.posterKey ?? null,
    sourceKey: row?.sourceKey ?? original?.key ?? null,
    assets: { proceed: proceeds.length, cover: covers.length, metadata: metadatas.length },
    products,
    productSettings: serializeMediaProductSettings(settings),
  };
}

// ---- 媒资级产物展示与默认（spec.md §6.3/§11.1，2026-11-15） ----

/**
 * 保存媒资级产物设置（管理端「转码产物」抽屉）：
 *   - visible_template_ids = null / []：全部展示；数组 = 白名单（只保留当前实际存在的模板产物）；
 *   - default_template_id 必须存在且处于展示范围；
 *   - 默认产物被移出展示范围且本次未显式改默认 → 自动取消默认（避免留着一个不生效的默认）。
 * 只影响播放端 play 的 templates[] 与自动选择，不删除任何存储对象、不改变产物可访问性。
 */
export async function updateMediaProductSettings(
  id: string,
  input: { visible_template_ids?: string[] | null; default_template_id?: string | null },
): Promise<z.infer<typeof MediaProductSettingsDTO>> {
  assertMediaId(id);
  const row = await db.media
    .findUnique({ where: { id }, select: { productSettings: true } })
    .catch(() => null);
  if (!row) throw new MediaError("not_found", `媒资不存在：${id}`, 404);

  const storage = await getStorage();
  const proceeds = await storage.listObjects(`${STORAGE_PARTITIONS.proceed}/${id}/`);
  const allTemplateIds = (groupProductsByMedia(proceeds).get(id) ?? [])
    .map((p) => p.templateId)
    .filter(Boolean);

  const existing = parseMediaProductSettings(row.productSettings);

  let visible = existing.visibleTemplateIds;
  if (input.visible_template_ids !== undefined) {
    const requested = [...new Set(input.visible_template_ids ?? [])].filter((t) =>
      allTemplateIds.includes(t),
    );
    visible = requested.length ? requested : null; // 空选择 = 全部展示（至少保留一套）
  }

  let def = existing.defaultTemplateId;
  const defExplicit = input.default_template_id !== undefined;
  if (defExplicit) def = input.default_template_id ?? null;

  if (def != null) {
    if (!allTemplateIds.includes(def)) {
      throw new MediaError("bad_request", "该模板产物不存在（先转码产出后再设为默认）", 400);
    }
    if (visible != null && !visible.includes(def)) {
      if (defExplicit) {
        throw new MediaError("bad_request", "默认产物必须在展示范围内", 400);
      }
      def = null;
    }
  }

  const settings = { visibleTemplateIds: visible, defaultTemplateId: def };
  await db.media.update({
    where: { id },
    data: { productSettings: serializeMediaProductSettings(settings) },
  });
  return serializeMediaProductSettings(settings);
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

// ---- 自定义上传时间（spec.md §3.1：管理端展示 + 分发端列表排序回退；不进入元数据投影） ----

/**
 * 设置 / 清除媒资自定义上传时间：
 * - `uploadedAt` = ISO 8601 字符串 → 落库 `media.uploaded_at`（管理端展示优先，分发端排序第二级回退）；
 * - `null` → 清除自定义（管理端展示回退存储对象原始写入时间，分发端排序回退 created_at）。
 * 只改 DB 列，不触碰存储对象（original 的写入时间由对象存储决定，不可改）。
 */
export async function updateMediaUploadedAt(
  id: string,
  uploadedAt: string | null,
): Promise<{ id: string; uploadedAt: string | null }> {
  assertMediaId(id);
  let value: Date | null = null;
  if (uploadedAt !== null) {
    const parsed = new Date(uploadedAt);
    if (Number.isNaN(parsed.getTime())) {
      throw new MediaError("bad_request", `上传时间非法（需 ISO 8601 时间）：${uploadedAt}`, 400);
    }
    value = parsed;
  }
  try {
    const row = await db.media.update({
      where: { id },
      data: { uploadedAt: value },
      select: { id: true, uploadedAt: true },
    });
    return { id: row.id, uploadedAt: row.uploadedAt?.toISOString() ?? null };
  } catch (e) {
    if (isRecordNotFound(e)) {
      throw new MediaError("not_found", `媒资不存在或未入库：${id}`, 404);
    }
    throw new MediaError("internal", `上传时间更新失败：${(e as Error).message}`, 500);
  }
}

// ---- 自定义元数据：分类 / 描述 / 标签 → custom_data 投影（spec.md §8.2/§8.3） ----

export interface UpdateMediaMetadataInput {
  /** 缺省 = 不修改；null = 清空描述 */
  description?: string | null;
  /** 缺省 = 不修改；null / 空数组 = 清空标签 */
  tags?: string[] | null;
  /** 缺省 = 不修改；null = 移出分类（分类必须存在，否则 404） */
  categoryId?: string | null;
}

export interface UpdateMediaMetadataResult {
  id: string;
  /** 管理端读取形态（恒三项） */
  custom: z.infer<typeof MediaCustomMetadataDTO>;
  /** custom_data 投影（稀疏 JSON；= metadata/{id}/custom.json 的内容） */
  customData: Record<string, unknown>;
  customObjectKey: string;
  /** custom.json 导出是否成功（DB 已保存，导出失败仅告警、不回滚） */
  customObjectWritten: boolean;
}

/**
 * 更新媒资自定义元数据（分类 / 描述 / 标签任一或多项，spec.md §8.2）：
 * 1. 读取当前行 → 分类引用（写入严格校验存在性）；
 * 2. 重算 custom_data 投影（保留白名单外扩展键）；
 * 3. 落库（description / tags / category_id / custom_data 同写）；
 * 4. 导出 `metadata/{id}/custom.json`（best-effort：失败不回滚 DB，下一次保存补齐）。
 */
export async function updateMediaMetadata(
  id: string,
  input: UpdateMediaMetadataInput,
): Promise<UpdateMediaMetadataResult> {
  assertMediaId(id);
  const row = await db.media
    .findUnique({
      where: { id },
      select: { id: true, description: true, tags: true, customData: true, categoryId: true },
    })
    .catch(() => null);
  if (!row) throw new MediaError("not_found", `媒资不存在或未入库：${id}`, 404);

  const category =
    input.categoryId === undefined
      ? // 现状：显式分类 → 该分类；未设置（历史数据）→ 系统默认分类「其他」
        pickCategoryRef(await loadCategoryLookup(), row.categoryId)
      : input.categoryId === null
        ? // 移出分类 → 归入默认分类「其他」（spec.md §8.1 修订）
          pickCategoryRef(await loadCategoryLookup(), null)
        : await requireCategoryRef(input.categoryId);
  const description =
    (input.description !== undefined ? input.description : row.description)?.trim() || null;
  const tags = normalizeMediaTags(
    input.tags !== undefined ? (input.tags ?? []) : parseMediaTags(row.tags),
  );
  const customData = mergeCustomData(row.customData, { category, description, tags });

  try {
    await db.media.update({
      where: { id },
      data: {
        description,
        tags: tags.length ? tags : null,
        categoryId: category?.id ?? null,
        customData,
      },
      select: { id: true },
    });
  } catch (e) {
    if (isRecordNotFound(e)) {
      throw new MediaError("not_found", `媒资不存在或未入库：${id}`, 404);
    }
    throw new MediaError("internal", `元数据回写数据库失败：${(e as Error).message}`, 500);
  }

  const customObjectKey = STORAGE_KEYS.metadataCustom(id);
  let customObjectWritten = false;
  try {
    await (await getStorage()).put(customObjectKey, serializeCustomData(customData), "application/json");
    customObjectWritten = true;
  } catch (e) {
    // 导出物是投影的副本：DB 为准，失败只告警（spec.md §8.3）
    console.warn(`[media] custom.json 导出失败（${customObjectKey}）：${(e as Error).message}`);
  }
  return { id, custom: { category, description, tags }, customData, customObjectKey, customObjectWritten };
}

/**
 * 指定分类（含子孙，由调用方展开）下的媒资 ID（分类改名 / 移动 / 删除前的受影响集合）。
 * `defaultCategoryId` 命中 `categoryIds` 时**一并包含未设置分类的历史媒资**（`category_id IS NULL`）——
 * 它们的分类投影等同默认分类「其他」，默认分类改名 / 移动时必须一起刷新（spec.md §8.1 修订）。
 */
export async function listMediaIdsByCategories(
  categoryIds: readonly string[],
  defaultCategoryId?: string | null,
): Promise<string[]> {
  if (!categoryIds.length) return [];
  const scope: Record<string, unknown>[] = [{ categoryId: { in: [...categoryIds] } }];
  if (defaultCategoryId && categoryIds.includes(defaultCategoryId)) {
    scope.push({ categoryId: null });
  }
  const rows = (await db.media.findMany({
    where: scope.length > 1 ? { OR: scope } : scope[0],
    select: { id: true },
  })) as Array<{ id: string }>;
  return rows.map((r) => r.id);
}

/**
 * 重算并落库指定媒资的自定义元数据投影（分类改名 / 移动 / 删除后同步，spec.md §8.3）：
 * 分类投影含 name / path 快照，不刷新会与分类表漂移；v1 同步逐条执行
 * （分类 + 受影响媒资规模小），超大规模演进为异步任务。
 */
export async function refreshMediaCustomProjections(mediaIds: readonly string[]): Promise<number> {
  if (!mediaIds.length) return 0;
  const lookup = await loadCategoryLookup();
  const storage = await getStorage().catch(() => null);
  let refreshed = 0;
  for (const mediaId of mediaIds) {
    const row = await db.media
      .findUnique({
        where: { id: mediaId },
        select: { description: true, tags: true, customData: true, categoryId: true },
      })
      .catch(() => null);
    if (!row) continue;
    const customData = mergeCustomData(row.customData, {
      // 未设置分类 → 回退系统默认分类「其他」（spec.md §8.1 修订）
      category: pickCategoryRef(lookup, row.categoryId),
      description: row.description,
      tags: parseMediaTags(row.tags),
    });
    await db.media.update({ where: { id: mediaId }, data: { customData } });
    refreshed += 1;
    if (storage) {
      try {
        await storage.put(
          STORAGE_KEYS.metadataCustom(mediaId),
          serializeCustomData(customData),
          "application/json",
        );
      } catch (e) {
        console.warn(`[media] custom.json 导出失败（${mediaId}）：${(e as Error).message}`);
      }
    }
  }
  return refreshed;
}

// ---- 删除（存储四分区该 id 全部对象 + DB 行 + 密钥行；spec.md §2 级联范围注记） ----

async function findOriginalKey(id: string): Promise<string | null> {
  const originals = await (await getStorage()).listObjects(`${STORAGE_PARTITIONS.original}/`);
  return originals.find((o) => ORIGINAL_RE.exec(o.key)?.[1] === id)?.key ?? null;
}

/**
 * 删除媒资：存储四分区该 id 全部对象 + DB 行。
 * `hls_keys` 由应用层显式删除（与媒资行同一事务），不单靠 `onDelete: Cascade`——
 * 外键级联一旦失效（连接未开 FK 约束 / 换 ORM 漏配，ADR-0020 风险条目），
 * 密钥行会静默残留并继续出现在密钥列表里。其余子表（subtitles / jobs / sessions）仍走级联。
 */
export async function deleteMedia(id: string): Promise<{ removed: boolean; key_removed: boolean }> {
  assertMediaId(id);
  const storage = await getStorage();
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
  // 数据库行：密钥先删（同时拿到「原本有没有密钥」），媒资行后删（其余子表走 onDelete: Cascade）；
  // 同一事务，任一步失败整体回滚，不会出现「媒资还在、密钥没了」的中间态
  let removed = Boolean(originalKey);
  let keyRemoved = false;
  try {
    const [keys, media] = await db.$transaction([
      db.hlsKey.deleteMany({ where: { mediaId: id } }),
      db.media.deleteMany({ where: { id } }),
    ]);
    keyRemoved = keys.count > 0;
    removed = removed || media.count > 0;
  } catch (e) {
    throw new MediaError("internal", `数据库删除失败：${(e as Error).message}`, 500);
  }
  return { removed, key_removed: keyRemoved };
}

// ---- 删除某套转码产物（proceed/{id}/{模板id}/ 子树；spec.md §1.3/§5.5） ----

// 未终结任务状态唯一真相源在 @openvod/contracts（spec.md §5.1 状态机）

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
  const storage = await getStorage();
  const objs = await storage.listObjects(`${STORAGE_PARTITIONS.proceed}/${id}/`);
  const targets = selectProductObjectKeys(objs, id, tpl);
  if (!targets.length) {
    throw new MediaError("not_found", "该产物不存在或已被删除", 404);
  }
  await Promise.all(targets.map((o) => storage.delete(o.key)));

  // 产物已删：同步清掉设置里的失效默认 / 白名单项（失败不阻断删除，读路径本身会降级）
  if (tpl) {
    const row = await db.media
      .findUnique({ where: { id }, select: { productSettings: true } })
      .catch(() => null);
    if (row) {
      const current = parseMediaProductSettings(row.productSettings);
      const visible = current.visibleTemplateIds?.filter((v) => v !== tpl) ?? null;
      const def = current.defaultTemplateId === tpl ? null : current.defaultTemplateId;
      const changed =
        def !== current.defaultTemplateId ||
        (current.visibleTemplateIds != null &&
          visible != null &&
          visible.length !== current.visibleTemplateIds.length);
      if (changed) {
        await db.media
          .update({
            where: { id },
            data: {
              productSettings: serializeMediaProductSettings({
                visibleTemplateIds: visible && visible.length ? visible : null,
                defaultTemplateId: def,
              }),
            },
          })
          .catch((e: unknown) =>
            console.warn(`[media] 产物设置清理失败（${id}/${tpl}）：${(e as Error).message}`),
          );
      }
    }
  }
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
  const storage = await getStorage();
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
  const covers = await (await getStorage()).listObjects(`${STORAGE_PARTITIONS.cover}/${id}/`);
  return covers.find((o) => /\/poster\.[a-z0-9]+$/i.test(o.key))?.key ?? null;
}

/** 业务错误 → 统一错误信封响应 */
export function mediaErrorResponse(e: unknown): NextResponse {
  if (e instanceof MediaError) return apiError(e.code, e.message, e.status);
  console.error("[media] unexpected error:", e);
  return apiError("internal", (e as Error)?.message ?? "内部错误", 500);
}
