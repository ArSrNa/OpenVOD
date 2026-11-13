// 系统设置层 v2（system_settings key-value，ADR-0015）：
//   - 键注册表唯一真相源在 @openvod/shared（SETTING_KEYS / SETTING_SECRET_KEYS / 默认值）；
//   - 解析顺序统一：DB 值 > env 兜底 > 出厂默认（env 永远是兜底，REQUIRED_KEYS 不因迁移减少）；
//   - 密钥类键（SETTING_SECRET_KEYS）以 MK 封装 hex 入库（AES-256-GCM，ADR-0006 分层）：
//     明文只在解封瞬间存在于内存，DB 泄露不解密；写入侧白名单强制，杜绝密钥被明文塞进设置表；
//   - 首次启动向导（/setup）经 completeSetup 写入存储与密钥配置并标记 setup_completed。
import {
  SETTING_DEFAULTS,
  SETTING_KEYS,
  SETTING_SECRET_KEYS,
  SETTING_TTL_LIMITS,
  STORAGE_SIGN_MODES,
  CDN_AUTH_TYPES,
  DEFAULTS,
  MEDIA_ID_CONFIG,
  resolveMediaIdLength,
  type SettingSecretKey,
} from "@openvod/shared";
import { parseMasterKeys, pickWrappingMasterKey, unwrap, wrap } from "@openvod/crypto";
import { getDb } from "@openvod/db";

import { apiError } from "./envelope";
import { masterKeysDiagnostic, type MasterKeysDiagnostic } from "./master-keys";
import { snapshotCache } from "./reloadable";

const database = () => getDb<any>();

export class SettingsError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

// ---- 密钥封装（复用 packages/crypto MK 封装，与 signing_keys 同形态：hex(iv||ct||tag)） ----

function masterKeys() {
  try {
    return parseMasterKeys(process.env.MASTER_KEYS);
  } catch (e) {
    throw new SettingsError("internal", (e as Error).message, 500);
  }
}

/** MK 根密钥是否可用（向导自检；MK 永远在 env，ADR-0015） */
export function hasMasterKeys(): boolean {
  return masterKeysDiagnostic().ok;
}

/** MK 自检详情（失败原因 / 已配置版本 / 形态提示；不回显任何密钥值） */
export function getMasterKeysDiagnostic(): MasterKeysDiagnostic {
  return masterKeysDiagnostic();
}

/** 明文 → MK 封装 hex（用最高版本 MK 封装） */
export function wrapSecretValue(plain: string): string {
  const mk = pickWrappingMasterKey(masterKeys());
  return wrap(mk.key, Buffer.from(plain, "utf8")).toString("hex");
}

/** MK 封装 hex → 明文（逐版本尝试，新版本优先；失败即密钥轮换后未保留旧版本） */
export function unwrapSecretValue(wrappedHex: string): string {
  const mks = masterKeys();
  const wrapped = Buffer.from(wrappedHex, "hex");
  for (const mk of [...mks].sort((a, b) => b.ver - a.ver)) {
    try {
      return unwrap(mk.key, wrapped).toString("utf8");
    } catch {
      // 试下一版本
    }
  }
  throw new SettingsError("internal", "设置中的密钥无法解封（MK 轮换后未保留旧版本？）", 500);
}

// ---- 键注册表：env 兜底名 + 写入校验 ----

type Validator = (v: string) => string; // 归一化后的合法值；非法抛 SettingsError

function urlValidator(label: string): Validator {
  return (v) => {
    const raw = v.trim().replace(/\/+$/, "");
    if (!raw) return "";
    let u: URL;
    try {
      u = new URL(raw);
    } catch {
      throw new SettingsError("bad_request", `${label}必须是合法的 http(s) URL`);
    }
    if (u.protocol !== "http:" && u.protocol !== "https:") {
      throw new SettingsError("bad_request", `${label}协议必须是 http / https`);
    }
    if (u.username || u.password || u.search || u.hash) {
      throw new SettingsError("bad_request", `${label}不能包含用户名、口令、查询参数或片段`);
    }
    return raw;
  };
}

function intValidator(label: string, min: number, max: number): Validator {
  return (v) => {
    const raw = v.trim();
    if (!raw) return "";
    const n = Number(raw);
    if (!Number.isInteger(n) || n < min || n > max) {
      throw new SettingsError("bad_request", `${label}必须是 ${min}–${max} 的整数`);
    }
    return String(n);
  };
}

function enumValidator(label: string, allowed: string[]): Validator {
  return (v) => {
    const raw = v.trim().toLowerCase();
    if (!raw) return "";
    if (!allowed.includes(raw)) throw new SettingsError("bad_request", `${label}必须是 ${allowed.join(" / ")}`);
    return raw;
  };
}

/** CDN 鉴权参数名形状（EO 控制台「鉴权加密串参数名称」）：1–100 位字母 / 数字 / 下划线；空串回退默认 */
function cdnAuthParamValidator(label: string): Validator {
  return (v) => {
    const raw = v.trim();
    if (raw && !/^[A-Za-z0-9_]{1,100}$/.test(raw)) {
      throw new SettingsError("bad_request", `${label}只能包含 1–100 位字母、数字或下划线（与 CDN 控制台一致）`);
    }
    return raw;
  };
}

/** CORS 来源列表：`*` 或逗号分隔 http(s) origin */
function corsOriginsValidator(): Validator {
  return (v) => {
    const raw = v.trim();
    if (!raw) return "";
    if (raw === "*") return "*";
    const parts = raw
      .split(",")
      .map((p) => p.trim().replace(/\/+$/, ""))
      .filter(Boolean);
    const origins = parts.map((p) => {
      try {
        const u = new URL(p);
        if (!["http:", "https:"].includes(u.protocol) || u.username || u.password || u.search || u.hash || u.pathname !== "/") throw new Error();
        return u.origin;
      } catch { throw new SettingsError("bad_request", "CORS 来源须为 * 或不含路径、凭据的 http(s) 来源；不能混用 * 与来源列表"); }
    });
    return [...new Set(origins)].join(",");
  };
}

/** 信任来源列表：条目为 http(s) URL 或裸域名（读侧展开 http+https），支持通配符前缀 */
function trustedOriginsValidator(): Validator {
  return (v) => {
    const raw = v.trim();
    if (!raw) return "";
    const parts = raw
      .split(",")
      .map((p) => p.trim().replace(/\/+$/, ""))
      .filter(Boolean);
    for (const p of parts) {
      if (p.includes("://")) {
        const normalized = p.replace("://*.", "://wildcard.");
        try {
          const u = new URL(normalized);
          if (!["http:", "https:"].includes(u.protocol) || u.username || u.password || u.search || u.hash || u.pathname !== "/") throw new Error();
        } catch { throw new SettingsError("bad_request", "信任来源必须是 http(s) 来源，不能包含路径或凭据"); }
      } else if (!/^(\*\.)?[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(p) || p.includes("..")) {
        throw new SettingsError("bad_request", `信任来源必须是合法域名：${p}`);
      }
    }
    return parts.join(",");
  };
}

/** 非密钥键：键名 → { env 兜底, 校验器 }（密钥键见 SECRET_META）。Record 形态便于字符串索引 */
const PLAIN_META: Record<string, { env?: string; validate: Validator } | undefined> = {
  [SETTING_KEYS.s3Endpoint]: { env: "S3_ENDPOINT", validate: urlValidator("S3 端点") },
  // 可选：同桶内网 / 本机端点（仅 Worker 取源片与水印图使用，2026-10-17）
  [SETTING_KEYS.s3EndpointInternal]: { env: "S3_ENDPOINT_INTERNAL", validate: urlValidator("S3 内网端点") },
  [SETTING_KEYS.s3Region]: { env: "S3_REGION", validate: (v) => v.trim() },
  [SETTING_KEYS.s3Bucket]: { env: "S3_BUCKET", validate: (v) => v.trim() },
  [SETTING_KEYS.s3AccessKeyId]: { env: "S3_ACCESS_KEY_ID", validate: (v) => v.trim() },
  [SETTING_KEYS.s3ForcePathStyle]: {
    env: "S3_FORCE_PATH_STYLE",
    validate: enumValidator("寻址风格", ["true", "false"]),
  },
  [SETTING_KEYS.storageRootPrefix]: { env: "STORAGE_ROOT_PREFIX", validate: (v) => {
    const normalized = v.trim().replace(/^\/+|\/+$/g, "");
    if (/[\\\x00-\x1f]/.test(normalized) || normalized.split("/").some((part) => part === "." || part === "..")) {
      throw new SettingsError("bad_request", "根前缀不能包含 .、..、反斜线或控制字符");
    }
    return normalized;
  } },
  [SETTING_KEYS.storageCdnBaseUrl]: { env: "STORAGE_CDN_BASE_URL", validate: urlValidator("加速域名") },
  [SETTING_KEYS.storageSignMode]: {
    env: "STORAGE_SIGN_MODE",
    validate: enumValidator("资产 URL 签名方式", [...STORAGE_SIGN_MODES]),
  },
  [SETTING_KEYS.storageCdnAuthTtlSec]: {
    env: "STORAGE_CDN_AUTH_TTL_SEC",
    validate: intValidator("CDN 鉴权有效期", SETTING_TTL_LIMITS[SETTING_KEYS.storageCdnAuthTtlSec].min, SETTING_TTL_LIMITS[SETTING_KEYS.storageCdnAuthTtlSec].max),
  },
  [SETTING_KEYS.storageCdnAuthType]: {
    env: "STORAGE_CDN_AUTH_TYPE",
    validate: enumValidator("CDN 鉴权方式", [...CDN_AUTH_TYPES]),
  },
  [SETTING_KEYS.storageCdnAuthParam]: { env: "STORAGE_CDN_AUTH_PARAM", validate: cdnAuthParamValidator("鉴权参数名") },
  [SETTING_KEYS.storageCdnAuthTokenParam]: {
    env: "STORAGE_CDN_AUTH_TOKEN_PARAM",
    validate: cdnAuthParamValidator("方式 D 签名参数名"),
  },
  [SETTING_KEYS.storageCdnAuthTimeParam]: {
    env: "STORAGE_CDN_AUTH_TIME_PARAM",
    validate: cdnAuthParamValidator("方式 D 时间戳参数名"),
  },
  [SETTING_KEYS.storageCustomSigner]: {
    env: "STORAGE_CUSTOM_SIGNER",
    validate: (v) => {
      const raw = v.trim();
      if (raw && !/^[a-zA-Z0-9_-]{1,64}$/.test(raw)) throw new SettingsError("bad_request", "自定义提供者名只能包含 1–64 位字母、数字、下划线或短横线");
      return raw;
    },
  },
  [SETTING_KEYS.playbackBaseUrl]: { env: "DELIVERY_PUBLIC_BASE_URL", validate: urlValidator("播放域名") },
  [SETTING_KEYS.urlSignKeyKid]: { env: "URL_SIGN_KEY_KID", validate: (v) => {
    const raw = v.trim();
    if (raw && !/^[a-zA-Z0-9_-]{1,64}$/.test(raw)) throw new SettingsError("bad_request", "签名密钥 ID 只能包含 1–64 位字母、数字、下划线或短横线");
    return raw;
  } },
  [SETTING_KEYS.jwtTtlSec]: { env: "DELIVERY_JWT_TTL_SEC", validate: intValidator("JWT 有效期", SETTING_TTL_LIMITS[SETTING_KEYS.jwtTtlSec].min, SETTING_TTL_LIMITS[SETTING_KEYS.jwtTtlSec].max) },
  [SETTING_KEYS.playbackSessionTtlSec]: {
    env: "PLAYBACK_SESSION_TTL_SEC",
    validate: intValidator(
      "播放会话有效期",
      SETTING_TTL_LIMITS[SETTING_KEYS.playbackSessionTtlSec].min,
      SETTING_TTL_LIMITS[SETTING_KEYS.playbackSessionTtlSec].max,
    ),
  },
  [SETTING_KEYS.playbackManifestTtlSec]: {
    env: "PLAYBACK_MANIFEST_TTL_SEC",
    validate: intValidator(
      "清单 token 有效期",
      SETTING_TTL_LIMITS[SETTING_KEYS.playbackManifestTtlSec].min,
      SETTING_TTL_LIMITS[SETTING_KEYS.playbackManifestTtlSec].max,
    ),
  },
  [SETTING_KEYS.playbackSubtitleTtlSec]: {
    env: "PLAYBACK_SUBTITLE_TTL_SEC",
    validate: intValidator(
      "字幕 token 有效期",
      SETTING_TTL_LIMITS[SETTING_KEYS.playbackSubtitleTtlSec].min,
      SETTING_TTL_LIMITS[SETTING_KEYS.playbackSubtitleTtlSec].max,
    ),
  },
  [SETTING_KEYS.playbackSubtitleCacheMaxAgeSec]: {
    env: "PLAYBACK_SUBTITLE_CACHE_MAX_AGE_SEC",
    validate: intValidator(
      "字幕缓存时长",
      SETTING_TTL_LIMITS[SETTING_KEYS.playbackSubtitleCacheMaxAgeSec].min,
      SETTING_TTL_LIMITS[SETTING_KEYS.playbackSubtitleCacheMaxAgeSec].max,
    ),
  },
  [SETTING_KEYS.corsOrigins]: { env: "DELIVERY_CORS_ORIGINS", validate: corsOriginsValidator() },
  [SETTING_KEYS.workerMode]: {
    env: "WORKER_MODE",
    validate: enumValidator("worker 运行模式", ["resident", "http", "invoked"]),
  },
  [SETTING_KEYS.workerPollIntervalMs]: { env: "WORKER_POLL_INTERVAL_MS", validate: intValidator("worker 轮询间隔", 500, 600000) },
  [SETTING_KEYS.workerNotifyUrl]: { env: "WORKER_NOTIFY_URL", validate: urlValidator("worker 唤醒地址") },
  [SETTING_KEYS.workerLeaseMs]: { env: "WORKER_LEASE_MS", validate: intValidator("worker lease", 5000, 3600000) },
  [SETTING_KEYS.workerMaxAttempts]: { env: "WORKER_MAX_ATTEMPTS", validate: intValidator("worker 最大尝试", 1, 20) },
  [SETTING_KEYS.adminBaseUrl]: { env: "ADMIN_BASE_URL", validate: urlValidator("管理端基址") },
  [SETTING_KEYS.adminTrustedOrigins]: { env: "ADMIN_TRUSTED_ORIGINS", validate: trustedOriginsValidator() },
  [SETTING_KEYS.adminSessionTtlSec]: {
    env: "ADMIN_SESSION_TTL_SEC",
    validate: intValidator(
      "管理端会话有效期",
      SETTING_TTL_LIMITS[SETTING_KEYS.adminSessionTtlSec].min,
      SETTING_TTL_LIMITS[SETTING_KEYS.adminSessionTtlSec].max,
    ),
  },
  [SETTING_KEYS.mediaIdLength]: {
    env: "MEDIA_ID_LENGTH",
    validate: intValidator("媒资 ID 位数", MEDIA_ID_CONFIG.minLength, MEDIA_ID_CONFIG.maxLength),
  },
  [SETTING_KEYS.deliveryPreviewUsername]: { env: "DELIVERY_PREVIEW_USERNAME", validate: (v) => v.trim() },
  [SETTING_KEYS.oidcIssuer]: { env: "OIDC_ISSUER", validate: urlValidator("OIDC Issuer") },
  [SETTING_KEYS.oidcClientId]: { env: "OIDC_CLIENT_ID", validate: (v) => v.trim() },
  [SETTING_KEYS.setupCompleted]: { validate: (v) => (v ? "1" : "") },
};

type SecretMeta = { env: string; label: string; validate?: Validator };
const SECRET_META: Record<SettingSecretKey, SecretMeta> = {
  url_sign_key_hex: {
    env: "URL_SIGN_KEY_HEX",
    label: "播放 token 签名密钥",
    validate: (v) => {
      const raw = v.trim();
      if (!raw) return "";
      if (!/^[0-9a-fA-F]{64}$/.test(raw)) {
        throw new SettingsError("bad_request", "播放 token 签名密钥必须是 64 位 hex（32 字节，openssl rand -hex 32）");
      }
      return raw.toLowerCase();
    },
  },
  better_auth_secret: {
    env: "BETTER_AUTH_SECRET",
    label: "管理端会话密钥",
    validate: (v) => {
      const raw = v.trim();
      if (!raw) return "";
      if (raw.length < 32) throw new SettingsError("bad_request", "管理端会话密钥至少 32 字符");
      return raw;
    },
  },
  s3_secret_access_key: { env: "S3_SECRET_ACCESS_KEY", label: "对象存储访问密钥", validate: (v) => v.trim() },
  oidc_client_secret: { env: "OIDC_CLIENT_SECRET", label: "OIDC 客户端密钥", validate: (v) => v.trim() },
  delivery_preview_password: { env: "DELIVERY_PREVIEW_PASSWORD", label: "播放预览账号口令", validate: (v) => v.trim() },
  worker_notify_secret: {
    env: "WORKER_NOTIFY_SECRET",
    label: "worker 唤醒密钥",
    validate: (v) => {
      const raw = v.trim();
      if (!raw) return "";
      if (raw.length < 16) throw new SettingsError("bad_request", "worker 唤醒密钥至少 16 字符");
      return raw;
    },
  },
  storage_cdn_auth_key: {
    env: "STORAGE_CDN_AUTH_KEY",
    label: "CDN 边缘鉴权密钥",
    validate: (v) => v.trim(),
  },
};

function assertKnownKey(key: string): void {
  const known =
    key === SETTING_KEYS.setupCompleted ||
    Object.hasOwn(PLAIN_META, key) ||
    (SETTING_SECRET_KEYS as readonly string[]).includes(key);
  if (!known) {
    throw new SettingsError("bad_request", `未登记的设置键：${key}（白名单外拒绝写入）`);
  }
}

export function isSecretSetting(key: string): key is SettingSecretKey {
  return (SETTING_SECRET_KEYS as readonly string[]).includes(key);
}

export function normalizeSettingValue(key: string, raw: unknown): string {
  assertKnownKey(key);
  if (typeof raw !== "string" || raw.length > 8192) throw new SettingsError("bad_request", "设置值必须是不超过 8192 字符的字符串");
  if (isSecretSetting(key)) return SECRET_META[key].validate?.(raw) ?? raw.trim();
  return PLAIN_META[key]!.validate(raw);
}

export function settingFallback(key: string, env: Record<string, string | undefined> = process.env): { value: string; source: "env" | "default" } {
  assertKnownKey(key);
  const envName = isSecretSetting(key) ? SECRET_META[key].env : PLAIN_META[key]?.env;
  const value = envName ? env[envName]?.trim() : undefined;
  return value ? { value, source: "env" } : { value: SETTING_DEFAULTS[key] ?? "", source: "default" };
}

// ---- 读侧：DB → env → 默认 ----

async function readRow(key: string): Promise<string | null> {
  const row = await database().systemSetting.findUnique({ where: { key }, select: { value: true } });
  return row?.value ?? null;
}

/** 单个明文键解析：DB > env > 默认 */
export async function resolvePlain(key: string): Promise<string> {
  assertKnownKey(key);
  const fromDb = await readRow(key).catch(() => null);
  if (fromDb !== null) return fromDb;
  const meta = PLAIN_META[key];
  if (meta?.env) {
    const ev = process.env[meta.env];
    if (ev && ev.trim() !== "") return ev.trim();
  }
  return SETTING_DEFAULTS[key] ?? "";
}

/** 单个密钥键解析：DB（解封）> env（明文兜底）；两者皆无返回空串 */
export async function resolveSecret(key: SettingSecretKey): Promise<string> {
  assertKnownKey(key);
  const fromDb = await readRow(key).catch(() => null);
  if (fromDb) return unwrapSecretValue(fromDb);
  const ev = process.env[SECRET_META[key].env];
  return ev?.trim() ? ev.trim() : "";
}

export type SettingSource = "db" | "env" | "default";

/** 单键解析 + 来源（UI 展示"生效值来自哪里"） */
export async function resolveWithSource(key: string): Promise<{ value: string; source: SettingSource; secret: boolean }> {
  assertKnownKey(key);
  const secret = (SETTING_SECRET_KEYS as readonly string[]).includes(key);
  const fromDb = await readRow(key).catch(() => null);
  if (fromDb !== null) {
    return { value: secret ? unwrapSecretValue(fromDb) : fromDb, source: "db", secret };
  }
  const envName = secret ? SECRET_META[key as SettingSecretKey].env : PLAIN_META[key]?.env;
  if (envName) {
    const ev = process.env[envName];
    if (ev && ev.trim() !== "") return { value: ev.trim(), source: "env", secret };
  }
  return { value: SETTING_DEFAULTS[key] ?? "", source: "default", secret };
}

// ---- 写侧：白名单 + 校验 + 密钥封装 ----

/** upsert 明文键（空串 = 删除行，回退 env/默认） */
async function writePlain(key: string, value: string): Promise<void> {
  if (value) {
    await database().systemSetting.upsert({
      where: { key },
      create: { key, value },
      update: { value },
    });
  } else {
    await database().systemSetting.deleteMany({ where: { key } });
  }
}

/** upsert 密钥键：明文先经 MK 封装再落库（空串 = 删除行回退 env） */
async function writeSecret(key: SettingSecretKey, plain: string): Promise<void> {
  if (plain) {
    await database().systemSetting.upsert({
      where: { key },
      create: { key, value: wrapSecretValue(plain) },
      update: { value: wrapSecretValue(plain) },
    });
  } else {
    await database().systemSetting.deleteMany({ where: { key } });
  }
}

/** 校验并写入一批设置（values: 键 → 值；密钥键传明文，内部封装） */
export async function writeSettings(values: Record<string, string>): Promise<void> {
  const entries = Object.entries(values).map(([key, raw]) => {
    const value = normalizeSettingValue(key, raw);
    return [key, value && isSecretSetting(key) ? wrapSecretValue(value) : value] as const;
  });
  await database().$transaction(async (tx: any) => {
    for (const [key, value] of entries) {
      if (value) await tx.systemSetting.upsert({ where: { key }, create: { key, value }, update: { value } });
      else await tx.systemSetting.deleteMany({ where: { key } });
    }
  });
  bustCache();
}

// ---- 快照（热路径：getStorage 每请求解析，30s 进程内缓存） ----

export interface StorageSnapshot {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle: boolean;
  cdnBaseUrl: string;
  rootPrefix: string;
  /** GET 签名方式（ADR-0019，默认 s3_presign） */
  signMode: string;
  cdnAuthKey: string;
  /** EO Token 鉴权方式（a | b | c | d | v，默认 a；与 CDN 控制台 Token 鉴权所选方式一致） */
  cdnAuthType: string;
  /** 方式 A 的鉴权 query 参数名（storage_cdn_auth_param，默认 sign） */
  cdnAuthParam: string;
  /** 方式 D 的签名参数名（storage_cdn_auth_token_param，默认 token） */
  cdnAuthTokenParam: string;
  /** 方式 D 的时间戳参数名（storage_cdn_auth_time_param，默认 t） */
  cdnAuthTimeParam: string;
  cdnAuthTtlSec: number;
  customSigner: string;
  /** 存储四要素（端点 / 桶 / AK / SK）齐全才算配置完成 */
  configured: boolean;
}

export interface SettingsSnapshot {
  setupCompleted: boolean;
  storage: StorageSnapshot;
  playbackBaseUrl: string;
  urlSignKeyKid: string;
  urlSignKeyHex: string;
  jwtTtlSec: number;
  sessionTtlSec: number;
  manifestTtlSec: number;
  subtitleTtlSec: number;
  corsOrigins: string[];
  worker: { pollIntervalMs: number; leaseMs: number; maxAttempts: number };
  admin: {
    baseUrl: string;
    trustedOrigins: string;
    sessionTtlSec: number;
    sessionSecret: string;
    mediaIdLength: number;
    previewUsername: string;
    previewPassword: string;
    oidcIssuer: string;
    oidcClientId: string;
    oidcClientSecret: string;
  };
}

const CACHE_TTL_MS = 30_000;

export function bustCache(): void {
  settingsCache.invalidate();
}

function toInt(v: string, fallback: number): number {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

function buildSettingsSnapshot(rows: Array<{ key: string; value: string }>): SettingsSnapshot {
  const env = process.env;
  const map = new Map(rows.map((r) => [r.key, r.value]));

  const get = (key: string): string => {
    const fromDb = map.get(key);
    if (fromDb !== undefined && fromDb !== null) return fromDb;
    const envName = (SETTING_SECRET_KEYS as readonly string[]).includes(key)
      ? SECRET_META[key as SettingSecretKey].env
      : PLAIN_META[key]?.env;
    if (envName) {
      const ev = env[envName];
      if (ev && ev.trim() !== "") return ev.trim();
    }
    return SETTING_DEFAULTS[key] ?? "";
  };
  const getSecret = (key: SettingSecretKey): string => {
    const fromDb = map.get(key);
    if (fromDb) return unwrapSecretValue(fromDb);
    const ev = env[SECRET_META[key].env];
    return ev?.trim() ? ev.trim() : "";
  };

  const s3Endpoint = get(SETTING_KEYS.s3Endpoint);
  const s3Bucket = get(SETTING_KEYS.s3Bucket);
  const s3Ak = get(SETTING_KEYS.s3AccessKeyId);
  const s3Sk = getSecret("s3_secret_access_key");
  const snap: SettingsSnapshot = {
    setupCompleted: get(SETTING_KEYS.setupCompleted) === "1",
    storage: {
      endpoint: s3Endpoint,
      region: get(SETTING_KEYS.s3Region),
      bucket: s3Bucket,
      accessKeyId: s3Ak,
      secretAccessKey: s3Sk,
      forcePathStyle: get(SETTING_KEYS.s3ForcePathStyle) !== "false",
      cdnBaseUrl: get(SETTING_KEYS.storageCdnBaseUrl).replace(/\/+$/, ""),
      rootPrefix: get(SETTING_KEYS.storageRootPrefix),
      signMode: get(SETTING_KEYS.storageSignMode) || "s3_presign",
      cdnAuthKey: getSecret("storage_cdn_auth_key"),
      cdnAuthType: get(SETTING_KEYS.storageCdnAuthType) || "a",
      cdnAuthParam: get(SETTING_KEYS.storageCdnAuthParam) || "sign",
      cdnAuthTokenParam: get(SETTING_KEYS.storageCdnAuthTokenParam) || "token",
      cdnAuthTimeParam: get(SETTING_KEYS.storageCdnAuthTimeParam) || "t",
      cdnAuthTtlSec: toInt(get(SETTING_KEYS.storageCdnAuthTtlSec), 3600),
      customSigner: get(SETTING_KEYS.storageCustomSigner) || "custom",
      configured: Boolean(s3Endpoint && s3Bucket && s3Ak && s3Sk),
    },
    playbackBaseUrl: get(SETTING_KEYS.playbackBaseUrl).replace(/\/+$/, ""),
    urlSignKeyKid: get(SETTING_KEYS.urlSignKeyKid),
    urlSignKeyHex: getSecret("url_sign_key_hex"),
    jwtTtlSec: toInt(get(SETTING_KEYS.jwtTtlSec), DEFAULTS.jwtTtlSec),
    sessionTtlSec: toInt(get(SETTING_KEYS.playbackSessionTtlSec), DEFAULTS.playbackSessionTtlSec),
    manifestTtlSec: toInt(get(SETTING_KEYS.playbackManifestTtlSec), DEFAULTS.manifestTtlSec),
    subtitleTtlSec: toInt(get(SETTING_KEYS.playbackSubtitleTtlSec), DEFAULTS.subtitleTtlSec),
    corsOrigins: get(SETTING_KEYS.corsOrigins).split(",").map((s) => s.trim()).filter(Boolean),
    worker: {
      pollIntervalMs: toInt(get(SETTING_KEYS.workerPollIntervalMs), 2000),
      leaseMs: toInt(get(SETTING_KEYS.workerLeaseMs), 60_000),
      maxAttempts: toInt(get(SETTING_KEYS.workerMaxAttempts), 3),
    },
    admin: {
      baseUrl: get(SETTING_KEYS.adminBaseUrl).replace(/\/+$/, ""),
      trustedOrigins: get(SETTING_KEYS.adminTrustedOrigins),
      sessionTtlSec: toInt(get(SETTING_KEYS.adminSessionTtlSec), 8 * 3600),
      sessionSecret: getSecret("better_auth_secret"),
      mediaIdLength: resolveMediaIdLength(get(SETTING_KEYS.mediaIdLength)),
      previewUsername: get(SETTING_KEYS.deliveryPreviewUsername),
      previewPassword: getSecret("delivery_preview_password"),
      oidcIssuer: get(SETTING_KEYS.oidcIssuer).replace(/\/+$/, ""),
      oidcClientId: get(SETTING_KEYS.oidcClientId),
      oidcClientSecret: getSecret("oidc_client_secret"),
    },
  };
  return snap;
}

const settingsCache = snapshotCache(async () => buildSettingsSnapshot(
  await database().systemSetting.findMany({ select: { key: true, value: true } }),
), CACHE_TTL_MS);

/** 30s 快照；运行期故障沿用最后有效值，冷启动无快照才尝试 env 兜底。 */
export async function getSettingsSnapshot(): Promise<SettingsSnapshot> {
  return settingsCache.read().catch(() => buildSettingsSnapshot([]));
}

// ---- 首次启动向导（/setup） ----

export async function isSetupCompleted(): Promise<boolean> {
  return (await readRow(SETTING_KEYS.setupCompleted).catch(() => null)) === "1";
}

/** 存储配置是否完整（决定向导是否必须走 /setup；读快照缓存） */
export async function isStorageConfigured(): Promise<boolean> {
  return (await getSettingsSnapshot()).storage.configured;
}

export interface SetupPayload {
  s3_endpoint: string;
  s3_region: string;
  s3_bucket: string;
  s3_access_key_id: string;
  s3_secret_access_key: string;
  s3_force_path_style: string;
  storage_root_prefix: string;
  storage_cdn_base_url: string;
  playback_base_url?: string;
  /** 提供则覆盖自动生成（可选） */
  url_sign_key_hex?: string;
  better_auth_secret?: string;
  oidc_issuer?: string;
  oidc_client_id?: string;
  oidc_client_secret?: string;
  /** 首个管理员账号（可选；仅库中无 admin_user 时创建） */
  admin_email?: string;
  admin_password?: string;
  admin_name?: string;
}

/**
 * 完成首次启动向导：写入存储 / 播放配置，密钥未提供时自动生成（MK 封装入库），
 * 最后落 setup_completed 标记。仅允许在未完成时调用一次。
 */
export async function completeSetup(payload: SetupPayload): Promise<{ setup_completed: true }> {
  if (await isSetupCompleted()) {
    throw new SettingsError("forbidden", "系统已完成初始化，如需修改请在「系统设置」中操作", 403);
  }
  const values: Record<string, string> = {
    [SETTING_KEYS.s3Endpoint]: payload.s3_endpoint ?? "",
    [SETTING_KEYS.s3Region]: payload.s3_region ?? "",
    [SETTING_KEYS.s3Bucket]: payload.s3_bucket ?? "",
    [SETTING_KEYS.s3AccessKeyId]: payload.s3_access_key_id ?? "",
    s3_secret_access_key: payload.s3_secret_access_key ?? "",
    [SETTING_KEYS.s3ForcePathStyle]: payload.s3_force_path_style || "true",
    [SETTING_KEYS.storageRootPrefix]: payload.storage_root_prefix ?? "",
    [SETTING_KEYS.storageCdnBaseUrl]: payload.storage_cdn_base_url ?? "",
    [SETTING_KEYS.playbackBaseUrl]: payload.playback_base_url ?? "",
  };
  if (payload.oidc_issuer) {
    values[SETTING_KEYS.oidcIssuer] = payload.oidc_issuer;
    values[SETTING_KEYS.oidcClientId] = payload.oidc_client_id ?? "";
    values.oidc_client_secret = payload.oidc_client_secret ?? "";
  }
  await writeSettings(values);

  // 密钥类：env 与 DB 均无 → 自动生成并封装入库（向导不强制用户理解密钥）
  if (!(await resolveSecret("url_sign_key_hex"))) {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    await writeSecret("url_sign_key_hex", Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join(""));
  }
  if (!(await resolveSecret("better_auth_secret"))) {
    const bytes = new Uint8Array(48);
    crypto.getRandomValues(bytes);
    await writeSecret("better_auth_secret", Buffer.from(bytes).toString("base64url"));
  }

  await writePlain(SETTING_KEYS.setupCompleted, "1");
  bustCache();
  return { setup_completed: true };
}

/** 路由统一错误映射 */
export function settingsErrorResponse(e: unknown) {
  if (e instanceof SettingsError) {
    return apiError(e.code, e.message, e.status);
  }
  // Prisma/驱动错误可能包含 SQL 参数（包括封装值），只记录类别。
  console.error("[settings] unexpected error:", e instanceof Error ? e.name : "unknown");
  return apiError("internal", "系统设置操作失败", 500);
}
