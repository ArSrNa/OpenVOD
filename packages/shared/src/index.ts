// 全局共享常量与错误码（双端一致，错误码表即 API 契约的一部分，ADR-0010）

export const ERROR_CODES = [
  "unauthorized",
  "invalid_credentials",
  "forbidden",
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
  // cover：封面与图片
  coverPoster: (mediaId: string) => `cover/${mediaId}/poster.jpg`,
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

export const DEFAULTS = {
  jwtTtlSec: 24 * 3600,
  playbackSessionTtlSec: 4 * 3600,
  manifestTtlSec: 4 * 3600,
  subtitleTtlSec: 24 * 3600,
  hlsTimeSec: 6,
} as const;
