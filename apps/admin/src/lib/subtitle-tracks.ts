// 字幕轨道业务规则（spec.md §7；ADR-0009）：一媒资多轨 / 语言唯一 / 默认轨 / 同步校验。
// 纯编排：DB 与对象存储全部经 `SubtitleDeps` 注入（同 lib/transcode-submit.ts 的模式），
// 不 import next / @openvod/db，便于纯单测；生产实现见 lib/subtitles.ts。
import {
  MEDIA_ID_PATTERN,
  STORAGE_KEYS,
  SUBTITLE_TRACK_ID_PATTERN,
  generateSubtitleTrackId,
} from "@openvod/shared";
import { SubtitleTrackDTO, UpdateSubtitleTrackRequest, z } from "@openvod/contracts";
import { VttError, normalizeSubtitleLabel, normalizeSubtitleLang, toVttText } from "./vtt";

/** 业务错误（code 对齐 @openvod/shared ERROR_CODES） */
export class SubtitleError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export type SubtitleTrackDto = z.infer<typeof SubtitleTrackDTO>;

/** `media_subtitles` 行（按需 select；本表无敏感字段） */
export interface SubtitleRow {
  id: string;
  mediaId: string;
  lang: string;
  label: string;
  isDefault: boolean;
  status: string;
  storageKey: string;
  bytes: number;
  /** 内容版本号（ADR-0009 2026-11-13 修订）：覆盖文本 +1，进入字幕签名 URL ?v= */
  contentVersion: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface SubtitleCreateData {
  id: string;
  mediaId: string;
  lang: string;
  label: string;
  isDefault: boolean;
  storageKey: string;
  bytes: number;
  createdBy: string | null;
}

/** 更新字段（缺省 = 不修改）；contentVersion 传 Prisma `{ increment: n }` 形态 */
export interface SubtitleUpdateData {
  lang?: string;
  label?: string;
  isDefault?: boolean;
  bytes?: number;
  contentVersion?: { increment: number };
}

export interface SubtitleDeps {
  /** 媒资是否存在（DB 行）；不存在即 404（与封面上传同口径） */
  mediaExists(mediaId: string): Promise<boolean>;
  listTracks(mediaId: string): Promise<SubtitleRow[]>;
  findTrack(mediaId: string, trackId: string): Promise<SubtitleRow | null>;
  /** 同媒资 + 语言（归一化后）的轨道（唯一约束的应用层预检） */
  findTrackByLang(mediaId: string, lang: string): Promise<SubtitleRow | null>;
  hasTracks(mediaId: string): Promise<boolean>;
  /** 落库（`status=READY`）；`isDefault=true` 时须在**同一事务**内清除该媒资其它默认轨 */
  createTrack(data: SubtitleCreateData): Promise<SubtitleRow>;
  /** 更新；`makeDefault=true` 时须在**同一事务**内清除该媒资其它默认轨 */
  updateTrack(
    id: string,
    mediaId: string,
    data: SubtitleUpdateData,
    makeDefault: boolean,
  ): Promise<SubtitleRow>;
  deleteTrack(id: string): Promise<void>;
  /** 生成轨道 ID（默认 generateSubtitleTrackId，须先于落库确定存储键） */
  newTrackId(): string;
  putObject(key: string, bytes: Uint8Array): Promise<void>;
  /** 读取对象（字幕预览用；对象不存在时实现方抛错，由编排层转 404） */
  getObject(key: string): Promise<Uint8Array>;
  /** 删除对象（实现方须幂等：对象不存在不抛错） */
  deleteObject(key: string): Promise<void>;
  /** 对象是否存在（存储不可用 → null） */
  objectExists(key: string): Promise<boolean | null>;
}

function assertMediaId(mediaId: string): void {
  if (!MEDIA_ID_PATTERN.test(mediaId)) {
    throw new SubtitleError("not_found", `媒资不存在：${mediaId}`, 404);
  }
}

/** 轨道 ID 形状白名单（spec.md §7.1 / §7.4）：不符一律 404，兼作路径注入防护 */
function assertTrackId(trackId: string): void {
  if (!SUBTITLE_TRACK_ID_PATTERN.test(trackId)) {
    throw new SubtitleError("not_found", `字幕轨道不存在：${trackId}`, 404);
  }
}

/** VttError（校验失败）→ SubtitleError 400；其余原样抛出 */
function wrapVtt<T>(fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    if (e instanceof VttError) throw new SubtitleError("bad_request", e.message, 400);
    throw e;
  }
}

/** zod 校验失败 → 400（取首条 issue，带字段路径） */
function firstIssue(error: z.ZodError): string {
  const issue = error.issues[0];
  const path = issue?.path?.length ? `${issue.path.join(".")}: ` : "";
  return `${path}${issue?.message ?? "请求体校验失败"}`;
}

async function toDto(row: SubtitleRow, deps: SubtitleDeps): Promise<SubtitleTrackDto> {
  return {
    id: row.id,
    lang: row.lang,
    label: row.label,
    is_default: row.isDefault,
    status: row.status as SubtitleTrackDto["status"],
    bytes: row.bytes,
    content_version: row.contentVersion,
    storage_key: row.storageKey,
    storage_ok: await deps.objectExists(row.storageKey),
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

// ---- 列表 ----

export async function listSubtitles(
  mediaId: string,
  deps: SubtitleDeps,
): Promise<{ items: SubtitleTrackDto[] }> {
  assertMediaId(mediaId);
  if (!(await deps.mediaExists(mediaId))) {
    throw new SubtitleError("not_found", `媒资不存在或未入库：${mediaId}`, 404);
  }
  const rows = await deps.listTracks(mediaId);
  return { items: await Promise.all(rows.map((r) => toDto(r, deps))) };
}

// ---- 新建（上传 VTT：校验 → 生成 trackId → 写对象 → 落库，spec.md §7.2） ----

export interface CreateSubtitleInput {
  /** 原始输入（兼容 `zh_CN` 下划线写法），服务端归一化 */
  lang: string;
  label: string;
  isDefault: boolean;
  /** 管理端账号 id（落 media_subtitles.created_by） */
  createdBy: string | null;
  /** 原始字幕字节流：`.vtt` 或 `.srt`（SRT 由服务端自动转换为 VTT 后存储，spec.md §7.3） */
  bytes: Uint8Array;
}

export async function createSubtitle(
  mediaId: string,
  input: CreateSubtitleInput,
  deps: SubtitleDeps,
): Promise<SubtitleTrackDto> {
  assertMediaId(mediaId);
  if (!(await deps.mediaExists(mediaId))) {
    throw new SubtitleError("not_found", `媒资不存在或未入库：${mediaId}`, 404);
  }
  const lang = wrapVtt(() => normalizeSubtitleLang(input.lang));
  const label = wrapVtt(() => normalizeSubtitleLabel(input.label));
  // 识别 VTT / SRT（SRT 自动转换）→ 校验 → 以 WebVTT（UTF-8 / LF / 无 BOM）存储（spec.md §7.3）
  const body = new TextEncoder().encode(wrapVtt(() => toVttText(input.bytes)));

  const conflict = await deps.findTrackByLang(mediaId, lang);
  if (conflict) {
    throw new SubtitleError(
      "bad_request",
      `该媒资已存在 ${lang} 语言的字幕轨道（${conflict.id}）；同一媒资内语言唯一`,
      409,
    );
  }

  const trackId = deps.newTrackId();
  const storageKey = STORAGE_KEYS.proceedSubtitle(mediaId, trackId);
  // 首条上传的轨道自动成为默认轨（spec.md §7.1）
  const isDefault = input.isDefault || !(await deps.hasTracks(mediaId));

  await deps.putObject(storageKey, body);
  try {
    const row = await deps.createTrack({
      id: trackId,
      mediaId,
      lang,
      label,
      isDefault,
      storageKey,
      bytes: body.length,
      createdBy: input.createdBy,
    });
    return await toDto(row, deps);
  } catch (e) {
    // 落库失败：回收刚写入的对象，避免孤儿对象（spec.md §7.2 写入顺序）
    await deps.deleteObject(storageKey).catch(() => {});
    throw e;
  }
}

// ---- 更新元信息（展示名 / 语言 / 默认轨；不重传文件） ----

export async function updateSubtitle(
  mediaId: string,
  trackId: string,
  body: unknown,
  deps: SubtitleDeps,
): Promise<SubtitleTrackDto> {
  assertMediaId(mediaId);
  assertTrackId(trackId);
  const row = await deps.findTrack(mediaId, trackId);
  if (!row) throw new SubtitleError("not_found", `字幕轨道不存在：${trackId}`, 404);

  const parsed = UpdateSubtitleTrackRequest.safeParse(body);
  if (!parsed.success) throw new SubtitleError("bad_request", firstIssue(parsed.error), 400);
  const input = parsed.data;

  const data: SubtitleUpdateData = {};
  if (input.label !== undefined) {
    const rawLabel = input.label; // 收窄在闭包内失效，先取局部量
    data.label = wrapVtt(() => normalizeSubtitleLabel(rawLabel));
  }
  if (input.lang !== undefined) {
    const rawLang = input.lang;
    const lang = wrapVtt(() => normalizeSubtitleLang(rawLang));
    if (lang !== row.lang) {
      const conflict = await deps.findTrackByLang(mediaId, lang);
      if (conflict && conflict.id !== trackId) {
        throw new SubtitleError(
          "bad_request",
          `该媒资已存在 ${lang} 语言的字幕轨道（${conflict.id}）；同一媒资内语言唯一`,
          409,
        );
      }
      data.lang = lang;
    }
  }
  if (input.is_default !== undefined) data.isDefault = input.is_default;

  const updated = await deps.updateTrack(trackId, mediaId, data, input.is_default === true);
  return await toDto(updated, deps);
}

// ---- 读取文本（字幕预览用，spec.md §7.4） ----

/**
 * 读取某条轨道的 WebVTT 字节流（管理端字幕预览：原视频 + 该字幕轨）。
 * 存储对象缺失（如被外部清理）→ 404，与列表里的 `storage_ok=false` 提示同一口径。
 */
export async function readSubtitleContent(
  mediaId: string,
  trackId: string,
  deps: SubtitleDeps,
): Promise<{ track: SubtitleRow; body: Uint8Array }> {
  assertMediaId(mediaId);
  assertTrackId(trackId);
  const row = await deps.findTrack(mediaId, trackId);
  if (!row) throw new SubtitleError("not_found", `字幕轨道不存在：${trackId}`, 404);
  try {
    return { track: row, body: await deps.getObject(row.storageKey) };
  } catch {
    throw new SubtitleError("not_found", "字幕文件不存在（可能已被清理），请重新上传", 404);
  }
}

// ---- 覆盖文本（就地覆盖同一对象，trackId 与键不变；spec.md §7.2） ----
// 同样接受 .vtt / .srt（SRT 自动转 VTT 后覆盖），见 lib/vtt.ts 的 toVttText。
// 内容版本号 +1（ADR-0009 2026-11-13 修订）：字幕 URL 携带 ?v=，版本变 = URL 变，
// CDN 缓存键隔离；旧 URL 由分发端校验版本不符 403（客户端经重签拿到新地址）。

export async function replaceSubtitleContent(
  mediaId: string,
  trackId: string,
  bytes: Uint8Array,
  deps: SubtitleDeps,
): Promise<SubtitleTrackDto> {
  assertMediaId(mediaId);
  assertTrackId(trackId);
  const row = await deps.findTrack(mediaId, trackId);
  if (!row) throw new SubtitleError("not_found", `字幕轨道不存在：${trackId}`, 404);

  const body = new TextEncoder().encode(wrapVtt(() => toVttText(bytes)));
  await deps.putObject(row.storageKey, body);
  const updated = await deps.updateTrack(
    trackId,
    mediaId,
    { bytes: body.length, contentVersion: { increment: 1 } },
    false,
  );
  return await toDto(updated, deps);
}

// ---- 删除（先删对象、再删行，幂等可重试；spec.md §7.2） ----

export async function deleteSubtitle(
  mediaId: string,
  trackId: string,
  deps: SubtitleDeps,
): Promise<{ id: string; lang: string; label: string }> {
  assertMediaId(mediaId);
  assertTrackId(trackId);
  const row = await deps.findTrack(mediaId, trackId);
  if (!row) throw new SubtitleError("not_found", `字幕轨道不存在：${trackId}`, 404);

  await deps.deleteObject(row.storageKey);
  await deps.deleteTrack(trackId);
  return { id: row.id, lang: row.lang, label: row.label };
}
