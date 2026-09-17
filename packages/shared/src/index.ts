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

// 存储键布局（ADR-0005）
export const STORAGE_KEYS = {
  rawSource: (mediaId: string, ext: string) => `raw/${mediaId}/source.${ext}`,
  hlsMaster: (mediaId: string) => `hls/${mediaId}/master.m3u8`,
  hlsVariantPlaylist: (mediaId: string, variant: string) =>
    `hls/${mediaId}/${variant}/index.m3u8`,
  hlsSegment: (mediaId: string, variant: string, n: number) =>
    `hls/${mediaId}/${variant}/seg-${n}.ts`,
  subtitle: (mediaId: string, trackId: string) => `sub/${mediaId}/${trackId}.vtt`,
  poster: (mediaId: string) => `thumb/${mediaId}/poster.jpg`,
} as const;

export const DEFAULTS = {
  jwtTtlSec: 24 * 3600,
  playbackSessionTtlSec: 4 * 3600,
  manifestTtlSec: 4 * 3600,
  subtitleTtlSec: 24 * 3600,
  hlsTimeSec: 6,
} as const;
