// 全局共享常量与错误码（双端一致，错误码表即 API 契约的一部分，ADR-0010）

export const ERROR_CODES = [
  "unauthorized",
  "invalid_credentials",
  "forbidden",
  "bad_request",
  "bad_token",
  "not_found",
  "not_playable",
  "session_limit",
  "rate_limited",
  "not_implemented",
  "internal",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

// 分发端签名 token 类型（ADR-0006 §4）
export const TOKEN_TYPES = {
  manifest: "m",
  segment: "s",
  key: "k",
  subtitle: "v",
} as const;

export type TokenType = (typeof TOKEN_TYPES)[keyof typeof TOKEN_TYPES];

// 存储布局（spec.md §1，取代 ADR-0005 旧 raw/hls/sub/thumb 布局）：
// 全局 root 前缀（STORAGE_ROOT_PREFIX）由存储适配层统一拼接（packages/storage rootPrefix），
// 这里的键均为不含 root 的相对键；分区直接挂在 root 下。
export const STORAGE_PARTITIONS = {
  original: "original", // 原始上传（一个媒资一个文件）
  proceed: "proceed", // 转码与处理产物（HLS 清单/分片、字幕等）
  cover: "cover", // 封面与图片资产
  metadata: "metadata", // 元数据（probe / 业务扩展）
} as const;

export type StoragePartition = (typeof STORAGE_PARTITIONS)[keyof typeof STORAGE_PARTITIONS];

export const STORAGE_KEYS = {
  // original：媒资唯一确定对象，{id}.{ext} 即媒资索引本身
  original: (mediaId: string, ext: string) => `original/${mediaId}.${ext}`,
  // proceed：HLS
  proceedHlsMaster: (mediaId: string) => `proceed/${mediaId}/master.m3u8`,
  proceedHlsVariantPlaylist: (mediaId: string, variant: string) =>
    `proceed/${mediaId}/${variant}/index.m3u8`,
  proceedHlsSegment: (mediaId: string, variant: string, n: number) =>
    `proceed/${mediaId}/${variant}/seg-${n}.ts`,
  // proceed：字幕（处理产物，spec.md §1.2）
  proceedSubtitle: (mediaId: string, trackId: string) =>
    `proceed/${mediaId}/subtitles/${trackId}.vtt`,
  // cover：封面与图片（ext 按实际上传格式落键，默认 jpg）
  coverPoster: (mediaId: string, ext: string = "jpg") => `cover/${mediaId}/poster.${ext}`,
  // metadata
  metadataProbe: (mediaId: string) => `metadata/${mediaId}/probe.json`,
  metadataCustom: (mediaId: string) => `metadata/${mediaId}/custom.json`,
} as const;

// 媒资 ID：纯数字字符串，默认 8 位（MEDIA_ID_LENGTH 可配，4–16），保留前导零；为
// original/proceed/cover/metadata 四分区资产的唯一索引（spec.md §1.3）
/** 字符模式（无锚点，供拼接复合正则，如按存储键解析媒资 ID） */
export const MEDIA_ID_CHARS = "[0-9]+";
/** 整串完整匹配（校验给定 ID 是否为合法媒资 ID） */
export const MEDIA_ID_PATTERN = /^\d+$/;

// 媒资 ID 生成（spec.md §1.3）：长度取 MEDIA_ID_LENGTH（4–16，默认 8）；在 [0, 10^n)
// 数字空间内随机取值并保留前导零（如 00000042，spec 示例），冲突时服务端重取；
// 以字符串传输与存储（避免数值类型丢失前导零），排序与展示按数值语义。
export const MEDIA_ID_CONFIG = {
  env: "MEDIA_ID_LENGTH",
  defaultLength: 8,
  minLength: 4,
  maxLength: 16,
} as const;

/** 解析 MEDIA_ID_LENGTH 环境变量；缺省 / 非法（非整数或越界）回退默认 8 */
export function resolveMediaIdLength(raw: string | undefined | null): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < MEDIA_ID_CONFIG.minLength || n > MEDIA_ID_CONFIG.maxLength) {
    return MEDIA_ID_CONFIG.defaultLength;
  }
  return n;
}

/**
 * 生成 n 位数字媒资 ID（保留前导零，crypto 级随机源）。
 * 逐位独立取 [0,9]（uint32 % 10，模偏差 <5e-10 可忽略），天然均匀覆盖含前导零的全值域。
 */
export function generateMediaId(length: number = MEDIA_ID_CONFIG.defaultLength): string {
  if (!Number.isInteger(length) || length < 1 || length > 32) {
    throw new Error(`媒资 ID 位数非法：${length}`);
  }
  const bytes = new Uint8Array(4);
  const view = new DataView(bytes.buffer);
  let id = "";
  for (let i = 0; i < length; i++) {
    crypto.getRandomValues(bytes);
    id += String(view.getUint32(0) % 10);
  }
  return id;
}

export const DEFAULTS = {
  jwtTtlSec: 24 * 3600,
  playbackSessionTtlSec: 4 * 3600,
  manifestTtlSec: 4 * 3600,
  subtitleTtlSec: 24 * 3600,
  hlsTimeSec: 6,
} as const;
