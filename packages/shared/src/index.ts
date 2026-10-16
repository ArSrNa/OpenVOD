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
  watermark: "watermark", // 水印图片（按水印模板 ID 组织，平台级模板资产，spec.md §10.2）
} as const;

export type StoragePartition = (typeof STORAGE_PARTITIONS)[keyof typeof STORAGE_PARTITIONS];

export const STORAGE_KEYS = {
  // original：媒资唯一确定对象，{id}.{ext} 即媒资索引本身
  original: (mediaId: string, ext: string) => `original/${mediaId}.${ext}`,
  // proceed：按「媒资 → 模板」两级分组（spec.md §1.3）——同一媒资可由多个模板各出一套产物并存，
  // 目录名即模板 ID，从而能回答「这份产物是哪个模板转出来的」
  proceedRoot: (mediaId: string, templateId: string) => `proceed/${mediaId}/${templateId}`,
  proceedHlsMaster: (mediaId: string, templateId: string) =>
    `proceed/${mediaId}/${templateId}/master.m3u8`,
  proceedHlsVariantPlaylist: (mediaId: string, templateId: string, variant: string) =>
    `proceed/${mediaId}/${templateId}/${variant}/index.m3u8`,
  proceedHlsSegment: (mediaId: string, templateId: string, variant: string, n: number) =>
    `proceed/${mediaId}/${templateId}/${variant}/seg-${n}.ts`,
  // proceed：字幕仍挂在媒资下（不属于任何模板产物；保留段，spec.md §1.3）
  proceedSubtitle: (mediaId: string, trackId: string) =>
    `proceed/${mediaId}/subtitles/${trackId}.vtt`,
  // cover：封面与图片（ext 按实际上传格式落键，默认 jpg）
  coverPoster: (mediaId: string, ext: string = "jpg") => `cover/${mediaId}/poster.${ext}`,
  // metadata
  metadataProbe: (mediaId: string) => `metadata/${mediaId}/probe.json`,
  metadataCustom: (mediaId: string) => `metadata/${mediaId}/custom.json`,
  // watermark：水印图片按**水印模板 ID**组织（非媒资 ID；平台级模板资产，spec.md §10.2）
  watermark: (templateId: string, ext: string) => `watermark/${templateId}.${ext}`,
} as const;

// ---- proceed 分区的产物目录识别（spec.md §1.3/§1.4） ----
/** 模板 ID 形状：Prisma cuid（`c` + 20 位以上小写字母数字）——用它区分「模板产物目录」与旧布局目录 */
export const TEMPLATE_ID_PATTERN = /^c[a-z0-9]{20,}$/;
/** `proceed/{id}/` 下不参与模板分组的保留段（字幕等非转码产物） */
export const PROCEED_RESERVED_SEGMENTS = ["subtitles"] as const;
/** 旧布局（无模板段，`proceed/{id}/{variant}/…`）在列表/详情里归入的名称 */
export const LEGACY_PRODUCT_LABEL = "未分组（旧布局）";

// ---- 字幕（WebVTT，spec.md §7 / ADR-0009）----

/** 字幕轨道 ID 形状：与模板 ID 同形（cuid 形状），用于路由 / 键名白名单校验（防路径注入） */
export const SUBTITLE_TRACK_ID_PATTERN = /^c[a-z0-9]{20,}$/;
/** 单字幕文件上限（字节）：5 MiB，低于 P0 的 6MB 响应体上限（spec.md §7.2） */
export const SUBTITLE_MAX_BYTES = 5 * 1024 * 1024;
/** 字幕展示名（label）长度上限（spec.md §7.1） */
export const SUBTITLE_LABEL_MAX = 64;
/** 字幕对象 Content-Type（分发端与存储落键共用） */
export const SUBTITLE_CONTENT_TYPE = "text/vtt; charset=utf-8";

/**
 * 生成字幕轨道 ID（spec.md §7.1）：cuid 形状（`c` + 24 位小写字母数字，共 25 字符）。
 * 必须先于落库生成 —— 存储键 `proceed/{mediaId}/subtitles/{trackId}.vtt` 要先于 DB 行确定，
 * 且该 ID 同时是 `media_subtitles.id`、存储文件名与 API 路径参数。
 */
export function generateSubtitleTrackId(): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  let id = "c";
  // 256 % 36 = 4 的模偏差对本用途（唯一性，非密码学随机）无实际影响
  for (const b of bytes) id += alphabet[b % alphabet.length];
  return id;
}

// ---- 水印（图片 / 文字，spec.md §10 / ADR-0018）----
// 模板落库（watermark_templates），图片资产落 watermark/ 分区；校验枚举与上限两端同源。

/** 水印模板 ID 形状：cuid 形状（路由与存储键白名单校验，防路径注入） */
export const WATERMARK_ID_PATTERN = /^c[a-z0-9]{20,}$/;
/** 模板名长度上限（唯一） */
export const WATERMARK_NAME_MAX = 64;
/** 模板描述长度上限 */
export const WATERMARK_DESCRIPTION_MAX = 191;
/** 文字水印内容长度上限（单行、不含控制字符） */
export const WATERMARK_TEXT_MAX = 64;
/** 水印图片上限（字节）：2 MiB（spec.md §10.2） */
export const WATERMARK_IMAGE_MAX_BYTES = 2 * 1024 * 1024;
/** x / y 偏移绝对值上限（像素，spec.md §10.1） */
export const WATERMARK_OFFSET_MAX = 4096;
/** 文字阴影偏移绝对值上限（像素） */
export const WATERMARK_SHADOW_OFFSET_MAX = 100;

/** 九宫格锚点（spec.md §10.4 定位换算表）：锚点对齐后施加带符号偏移（x 正 = 右、y 正 = 下） */
export const WATERMARK_ANCHORS = [
  "top_left",
  "top_center",
  "top_right",
  "middle_left",
  "center",
  "middle_right",
  "bottom_left",
  "bottom_center",
  "bottom_right",
] as const;

export type WatermarkAnchor = (typeof WATERMARK_ANCHORS)[number];

/** 混合方式（spec.md §10.4）：normal = 标准 alpha 叠加；overlay = Overlay 混合模式（「叠加」） */
export const WATERMARK_BLEND_MODES = ["normal", "overlay"] as const;

export type WatermarkBlendMode = (typeof WATERMARK_BLEND_MODES)[number];

/**
 * 文字水印字体枚举（spec.md §10.1）：Worker 镜像内置 Noto CJK 的固定清单，
 * 管理端下拉与（后续转码集成的）fontfile 映射共用同一键集。
 */
export const WATERMARK_FONTS = ["sans", "sans_bold", "serif"] as const;

export type WatermarkFont = (typeof WATERMARK_FONTS)[number];

/** 字体展示名（管理端下拉用） */
export const WATERMARK_FONT_LABELS: Record<WatermarkFont, string> = {
  sans: "黑体（思源黑体）",
  sans_bold: "黑体加粗（思源黑体 Bold）",
  serif: "宋体（思源宋体）",
};

/**
 * Worker 镜像内置字体目录（Debian `fonts-noto-cjk` 安装路径）。
 * drawtext 的 fontfile 根目录；字体随镜像分发、无环境变量（spec.md §10.6 / ADR-0018 §后果）。
 */
export const WATERMARK_FONT_DIR = "/usr/share/fonts/opentype/noto";

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

// ---- 媒资分类与自定义元数据（spec.md §8 / ADR-0016）----

/** 分类 ID 形状：与模板 ID / 字幕轨道 ID 同形（cuid 形状），路由与参数白名单校验（防路径注入） */
export const MEDIA_CATEGORY_ID_PATTERN = /^c[a-z0-9]{20,}$/;
/** 分类名长度上限（同级不允许重名；MySQL VARCHAR(191) 文本列语义） */
export const MEDIA_CATEGORY_NAME_MAX = 64;
/** 分类描述长度上限（同为 VARCHAR(191) 文本列） */
export const MEDIA_CATEGORY_DESCRIPTION_MAX = 191;
/** 同级排序权重上限（越小越靠前） */
export const MEDIA_CATEGORY_SORT_MAX = 10_000;
/** 媒资描述长度上限（media.description，VARCHAR(191)） */
export const MEDIA_DESCRIPTION_MAX = 191;
/** 单媒资标签数上限 */
export const MEDIA_TAGS_MAX = 20;
/** 单个标签长度上限 */
export const MEDIA_TAG_LENGTH_MAX = 32;
/** 分类路径分隔符（展示与自定义元数据投影共用，如 `电影 / 科幻`） */
export const MEDIA_CATEGORY_PATH_SEPARATOR = " / ";

// ---- 默认分类「其他」（spec.md §8.1 修订 2026-09-24）----
// 系统内置一条顶级分类「其他」：**未设置分类的媒资默认归入它**（读取时 status 空值回退、
// 上传时直接落库、删除分类时把该分类下媒资迁入），且该分类**不可删除**。
// ID 固定（cuid 形状，符合 MEDIA_CATEGORY_ID_PATTERN），迁移与运行时幂等创建共用同一个值。

/** 默认分类 ID（固定值；MySQL 迁移插入 + SQLite 开发库运行时幂等创建都使用它） */
export const MEDIA_DEFAULT_CATEGORY_ID = "cother00000000000000000";
/** 默认分类名 */
export const MEDIA_DEFAULT_CATEGORY_NAME = "其他";
/** 默认分类描述（首次创建时写入） */
export const MEDIA_DEFAULT_CATEGORY_DESCRIPTION =
  "未设置分类的媒资默认归入此分类（系统内置，不可删除）";

/**
 * 自定义元数据公开白名单键（ADR-0004「按公开白名单输出」，spec.md §8.4）：
 * media.custom_data 里其余键可存，但**不下发**给播放端。
 * Go 侧 `apps/delivery/internal/server/custom.go` 手工对齐这三个键。
 */
export const MEDIA_CUSTOM_KEYS = {
  category: "category",
  description: "description",
  tags: "tags",
} as const;

/** 自定义元数据中的分类投影（含 name / path 快照，分发端零 join 即可输出；分类改名 / 移动会同步刷新） */
export interface MediaCustomCategory {
  id: string;
  name: string;
  /** 祖先名 → 自身名，用 ` / ` 连接（如 `电影 / 科幻`） */
  path: string;
}

/** 媒资自定义元数据 v1 结构（= media.custom_data 的投影；空项不下发） */
export interface MediaCustomData {
  category?: MediaCustomCategory;
  description?: string;
  tags?: string[];
}

/** 分类路径：祖先名序列 → 展示字符串（`["电影","科幻"]` → `电影 / 科幻`） */
export function mediaCategoryPath(names: readonly string[]): string {
  return names.map((n) => n.trim()).filter(Boolean).join(MEDIA_CATEGORY_PATH_SEPARATOR);
}

/** 标签归一化：去首尾空白、丢弃空串、按首次出现去重（保留原大小写写法） */
export function normalizeMediaTags(tags: readonly string[]): string[] {
  const out: string[] = [];
  for (const raw of tags) {
    const t = raw.trim();
    if (t && !out.includes(t)) out.push(t);
  }
  return out;
}

/**
 * 构建自定义元数据投影（spec.md §8.3）：只保留非空项——无分类 / 空描述 / 空标签数组
 * 一律不出现在投影里（播放端按缺省处理）。管理端在写分类 / 描述 / 标签时重算，
 * 落 `media.custom_data` 并导出 `metadata/{id}/custom.json`。
 */
export function buildMediaCustomData(input: {
  category: MediaCustomCategory | null;
  description: string | null;
  tags: readonly string[];
}): MediaCustomData {
  const out: MediaCustomData = {};
  if (input.category) {
    out.category = { id: input.category.id, name: input.category.name, path: input.category.path };
  }
  const description = (input.description ?? "").trim();
  if (description) out.description = description;
  const tags = normalizeMediaTags(input.tags);
  if (tags.length) out.tags = tags;
  return out;
}

export const DEFAULTS = {
  jwtTtlSec: 24 * 3600,
  playbackSessionTtlSec: 4 * 3600,
  manifestTtlSec: 4 * 3600,
  subtitleTtlSec: 24 * 3600,
  hlsTimeSec: 6,
} as const;

// ---- 系统设置键注册表（system_settings key-value，ADR-0015） ----
// 唯一真相源：键名 / 默认值 / 是否密钥在此登记；Go 侧（apps/delivery/internal/settings）
// 手工对齐（与 token 类型同机制）。解析顺序统一为：DB 值 > env 兜底 > 出厂默认。
export const SETTING_KEYS = {
  // ---- 首次启动向导 ----
  setupCompleted: "setup_completed",
  // ---- 存储（ADR-0005：仅 S3 兼容；明文键） ----
  s3Endpoint: "s3_endpoint",
  s3Region: "s3_region",
  s3Bucket: "s3_bucket",
  s3AccessKeyId: "s3_access_key_id",
  s3ForcePathStyle: "s3_force_path_style",
  storageRootPrefix: "storage_root_prefix",
  storageCdnBaseUrl: "storage_cdn_base_url",
  // ---- 资产 URL 签名方式（ADR-0019：签名发生在 S3 还是 CDN） ----
  storageSignMode: "storage_sign_mode",
  /** CDN URL 鉴权边缘密钥（cdn_url_auth 模式必填；secret，MK 封装，与 CDN 控制台同款密钥双侧一致） */
  storageCdnAuthKey: "storage_cdn_auth_key",
  /** EO Token 鉴权方式（cdn_url_auth 模式）：与 CDN 控制台 Token 鉴权所选方式一致（a | b | c | d | v） */
  storageCdnAuthType: "storage_cdn_auth_type",
  /** 方式 A 的鉴权 query 参数名（CDN 控制台「鉴权加密串参数名称」，默认 sign，1–100 位字母/数字/下划线） */
  storageCdnAuthParam: "storage_cdn_auth_param",
  /** 鉴权 URL 有效期；timestamp 按 ttl 窗口对齐，窗口内 URL 稳定（缓存友好） */
  storageCdnAuthTtlSec: "storage_cdn_auth_ttl_sec",
  /** custom 模式的提供者名（TS registerUrlSigner / Go RegisterURLSigner 的注册名；默认 "custom"） */
  storageCustomSigner: "storage_custom_signer",
  // ---- 播放 / 分发 ----
  playbackBaseUrl: "playback_base_url",
  urlSignKeyKid: "url_sign_key_kid",
  jwtTtlSec: "jwt_ttl_sec",
  playbackSessionTtlSec: "playback_session_ttl_sec",
  playbackManifestTtlSec: "playback_manifest_ttl_sec",
  playbackSubtitleTtlSec: "playback_subtitle_ttl_sec",
  corsOrigins: "cors_origins",
  // ---- worker（ADR-0017：双模式 + HTTP 门铃） ----
  workerMode: "worker_mode",
  workerPollIntervalMs: "worker_poll_interval_ms",
  workerLeaseMs: "worker_lease_ms",
  workerMaxAttempts: "worker_max_attempts",
  workerNotifyUrl: "worker_notify_url",
  workerNotifySecret: "worker_notify_secret",
  // ---- 管理端 ----
  adminBaseUrl: "admin_base_url",
  adminTrustedOrigins: "admin_trusted_origins",
  adminSessionTtlSec: "admin_session_ttl_sec",
  mediaIdLength: "media_id_length",
  deliveryPreviewUsername: "delivery_preview_username",
  // ---- OIDC（可选；issuer / client_id 明文，client_secret 封装） ----
  oidcIssuer: "oidc_issuer",
  oidcClientId: "oidc_client_id",
} as const;

/** 密钥类设置键：值必须是 MK 封装的 hex（AES-256-GCM，ADR-0006 分层），白名单外明文写入拒绝 */
export const SETTING_SECRET_KEYS = [
  "url_sign_key_hex",
  "better_auth_secret",
  "s3_secret_access_key",
  "oidc_client_secret",
  "delivery_preview_password",
  "worker_notify_secret",
  "storage_cdn_auth_key",
] as const;

/** 资产 GET URL 签名方式（ADR-0019）：签名发生在 S3 还是 CDN（桶恒私有，不变量） */
export const STORAGE_SIGN_MODES = ["s3_presign", "cdn_url_auth", "custom"] as const;
export type StorageSignMode = (typeof STORAGE_SIGN_MODES)[number];

/** EO Token 鉴权方式（ADR-0019 / spec.md §6.7；cdn_url_auth 模式的 storage_cdn_auth_type）：
 *  与 EO 控制台 Token 鉴权「鉴权方式」一一对应（EO 官方共 5 种：A/B/C/D/V）。 */
export const CDN_AUTH_TYPES = ["a", "b", "c", "d", "v"] as const;
export type CdnAuthType = (typeof CDN_AUTH_TYPES)[number];

export type SettingSecretKey = (typeof SETTING_SECRET_KEYS)[number];

/** 设置键出厂默认值（DB 无行且 env 无值时生效；与 env-vars.md 对齐）。Record 形态便于跨端字符串索引 */
export const SETTING_DEFAULTS: Record<string, string> = {
  [SETTING_KEYS.s3ForcePathStyle]: "true",
  [SETTING_KEYS.storageSignMode]: "s3_presign",
  [SETTING_KEYS.storageCdnAuthTtlSec]: "3600",
  [SETTING_KEYS.storageCdnAuthType]: "a",
  [SETTING_KEYS.storageCdnAuthParam]: "sign",
  [SETTING_KEYS.storageCustomSigner]: "custom",
  [SETTING_KEYS.urlSignKeyKid]: "urlsign-v1",
  [SETTING_KEYS.jwtTtlSec]: String(DEFAULTS.jwtTtlSec),
  [SETTING_KEYS.playbackSessionTtlSec]: String(DEFAULTS.playbackSessionTtlSec),
  [SETTING_KEYS.playbackManifestTtlSec]: String(DEFAULTS.manifestTtlSec),
  [SETTING_KEYS.playbackSubtitleTtlSec]: String(DEFAULTS.subtitleTtlSec),
  [SETTING_KEYS.corsOrigins]: "*",
  [SETTING_KEYS.workerMode]: "resident",
  [SETTING_KEYS.workerPollIntervalMs]: "2000",
  [SETTING_KEYS.workerLeaseMs]: "60000",
  [SETTING_KEYS.workerMaxAttempts]: "3",
  [SETTING_KEYS.adminSessionTtlSec]: "28800",
  [SETTING_KEYS.mediaIdLength]: "8",
} as const;

/** TTL 上限防呆（秒）：误配成"永久 token"直接拒绝保存 */
export const SETTING_TTL_LIMITS = {
  [SETTING_KEYS.jwtTtlSec]: { min: 300, max: 30 * 24 * 3600 },
  [SETTING_KEYS.playbackSessionTtlSec]: { min: 300, max: 30 * 24 * 3600 },
  // 同时用于 S3 SigV4 预签名，其有效期上限为 7 天。
  [SETTING_KEYS.playbackManifestTtlSec]: { min: 60, max: 7 * 24 * 3600 },
  [SETTING_KEYS.playbackSubtitleTtlSec]: { min: 60, max: 30 * 24 * 3600 },
  // CDN URL 鉴权窗口（ADR-0019）：与 SigV4 同受 7 天上限（防误配成"永久 CDN URL"）
  [SETTING_KEYS.storageCdnAuthTtlSec]: { min: 60, max: 7 * 24 * 3600 },
  [SETTING_KEYS.adminSessionTtlSec]: { min: 600, max: 30 * 24 * 3600 },
} as const;
