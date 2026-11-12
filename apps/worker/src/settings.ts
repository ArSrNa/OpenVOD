// Worker 运行设置（ADR-0015）：从 system_settings 读取存储凭据与队列参数（env 兜底），
// 密钥键（s3_secret_access_key）以 MK 封装 hex 存储，读取时用 env MASTER_KEYS 解封。
// 快照带 30s 缓存：每轮 tick 读取参数即时生效，存储凭据变更按指纹重建适配器。
//
// 取源通路（2026-10-17，ADR-0019 修订）：Worker 取源片 / 水印图**不走** GET 签名提供者，
// 候选 = 内网端点（s3_endpoint_internal，可选）→ 存储直连 → 签名提供者（CDN，兜底），
// 由 source-fetch.ts 实测吞吐择优；播放端 / 管理端 URL 签名形态不受影响。
import { parseMasterKeys, unwrap, type MasterKey } from "@openvod/crypto";
import { getDb } from "@openvod/db";
import { createStorageFromConfig, type SignMode, type StorageAdapter } from "@openvod/storage";
import type { SourceFetcher } from "./source-fetch";

const db = getDb<any>();

export interface WorkerSettings {
  storage: StorageAdapter;
  storageConfigured: boolean;
  /** 取源片 / 水印图的候选通路（source-fetch.ts 实测吞吐择优；见文件头说明） */
  sourceFetchers: SourceFetcher[];
  pollIntervalMs: number;
  leaseMs: number;
  maxAttempts: number;
}

function toInt(v: string | undefined, fallback: number): number {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

function unwrapAny(mks: MasterKey[], wrappedHex: string): string {
  for (const mk of [...mks].sort((a, b) => b.ver - a.ver)) {
    try {
      return unwrap(mk.key, Buffer.from(wrappedHex, "hex")).toString("utf8");
    } catch {
      // 试下一版本
    }
  }
  throw new Error("设置 s3_secret_access_key 解封失败（MK 轮换后未保留旧版本？）");
}

interface RawSnapshot {
  values: Map<string, string>;
  /** 密钥键解封结果（懒解封，仅访问时消耗 MK） */
  secret: (key: string) => string;
}

let cached: { snap: RawSnapshot; until: number } | null = null;
const CACHE_TTL_MS = 30_000;

async function loadRaw(): Promise<RawSnapshot> {
  if (cached && cached.until > Date.now()) return cached.snap;
  const rows: Array<{ key: string; value: string }> = await db.systemSetting
    .findMany({ select: { key: true, value: true } })
    .catch(() => []);
  const values = new Map(rows.map((r) => [r.key, r.value]));
  let mks: MasterKey[] | undefined;
  try {
    mks = parseMasterKeys(process.env.MASTER_KEYS);
  } catch {
    mks = undefined;
  }
  const snap: RawSnapshot = {
    values,
    secret: (key) => {
      const fromDb = values.get(key);
      if (fromDb && mks?.length) return unwrapAny(mks, fromDb);
      return "";
    },
  };
  cached = { snap, until: Date.now() + CACHE_TTL_MS };
  return snap;
}

function pick(values: Map<string, string>, key: string, env: string): string {
  const fromDb = values.get(key);
  if (fromDb !== undefined && fromDb.trim() !== "") return fromDb.trim();
  const ev = process.env[env];
  return ev?.trim() ?? "";
}

/** 运行模式（ADR-0017）：DB > env > resident。启动时读一次，运行期不改。 */
export type WorkerMode = "resident" | "http" | "invoked";

export async function loadWorkerMode(): Promise<WorkerMode> {
  const { values } = await loadRaw();
  const mode = pick(values, "worker_mode", "WORKER_MODE").toLowerCase();
  // invoked = 异步云函数单任务触发（/wake 载荷带 jobId，不扫队列）；未知值一律回落 resident
  return mode === "http" || mode === "invoked" ? mode : "resident";
}

/**
 * serverless DB 冷启动探活（ADR-0017 §5）：loadRaw 对查询失败吞错返回空快照，
 * 不能用作探活；此函数连接失败即抛错，供启动退避重试包裹。
 */
export async function pingDb(): Promise<void> {
  await db.$queryRaw`SELECT 1`;
}

export async function loadWorkerSettings(): Promise<WorkerSettings> {
  const { values, secret } = await loadRaw();
  const endpoint = pick(values, "s3_endpoint", "S3_ENDPOINT");
  const endpointInternal = pick(values, "s3_endpoint_internal", "S3_ENDPOINT_INTERNAL");
  const bucket = pick(values, "s3_bucket", "S3_BUCKET");
  const accessKeyId = pick(values, "s3_access_key_id", "S3_ACCESS_KEY_ID");
  const secretAccessKey = secret("s3_secret_access_key") || process.env.S3_SECRET_ACCESS_KEY || "";
  const storageConfigured = Boolean(endpoint && bucket && accessKeyId && secretAccessKey);
  const region = pick(values, "s3_region", "S3_REGION");
  const forcePathStyle = (pick(values, "s3_force_path_style", "S3_FORCE_PATH_STYLE") || "true") !== "false";
  const rootPrefix = pick(values, "storage_root_prefix", "STORAGE_ROOT_PREFIX");
  const cdnBaseUrl = pick(values, "storage_cdn_base_url", "STORAGE_CDN_BASE_URL");
  const signMode = (pick(values, "storage_sign_mode", "STORAGE_SIGN_MODE") || undefined) as SignMode | undefined;
  const signModeRaw = (signMode ?? "s3_presign").trim().toLowerCase();
  const storage = createStorageFromConfig({
    endpoint,
    region,
    bucket,
    accessKeyId,
    secretAccessKey,
    forcePathStyle,
    cdnBaseUrl,
    rootPrefix,
    // GET 签名方式（ADR-0019）：不再用于取源片 / 水印图（走 sourceFetchers），
    // 保留为「签名提供者」兜底通路 + 管理性调用（put / list / stat）不经过它
    signMode,
    cdnAuthKey: secret("storage_cdn_auth_key") || process.env.STORAGE_CDN_AUTH_KEY || "",
    cdnAuthType: pick(values, "storage_cdn_auth_type", "STORAGE_CDN_AUTH_TYPE") || undefined,
    cdnAuthParam: pick(values, "storage_cdn_auth_param", "STORAGE_CDN_AUTH_PARAM") || undefined,
    cdnAuthTokenParam: pick(values, "storage_cdn_auth_token_param", "STORAGE_CDN_AUTH_TOKEN_PARAM") || undefined,
    cdnAuthTimeParam: pick(values, "storage_cdn_auth_time_param", "STORAGE_CDN_AUTH_TIME_PARAM") || undefined,
    cdnAuthTtlSec: toInt(pick(values, "storage_cdn_auth_ttl_sec", "STORAGE_CDN_AUTH_TTL_SEC"), 3600),
    customSignerName: pick(values, "storage_custom_signer", "STORAGE_CUSTOM_SIGNER") || undefined,
  });

  // ---- 取源通路候选（顺序即兜底顺序；source-fetch.ts 会实测吞吐择优）----
  const sourceFetchers: SourceFetcher[] = [];
  if (storageConfigured) {
    // 内网 / 本机端点（可选，s3_endpoint_internal）：与主端点同桶，恒走 SigV4 直连（不经 CDN 替换）
    if (endpointInternal && endpointInternal !== endpoint) {
      const internal = createStorageFromConfig({
        endpoint: endpointInternal,
        region,
        bucket,
        accessKeyId,
        secretAccessKey,
        forcePathStyle,
        rootPrefix,
      });
      sourceFetchers.push({ id: `internal:${endpointInternal}`, presign: (k, t) => internal.presignGet(k, t) });
    }
    // 存储端点直连（SigV4，不做 CDN origin 替换）
    const direct = createStorageFromConfig({
      endpoint,
      region,
      bucket,
      accessKeyId,
      secretAccessKey,
      forcePathStyle,
      rootPrefix,
    });
    sourceFetchers.push({ id: `direct:${endpoint}`, presign: (k, t) => direct.presignGet(k, t) });
    // 签名提供者（现状行为：cdn_url_auth 的 CDN 鉴权 URL / s3_presign 的加速域名）——仅作兜底
    if (signModeRaw !== "s3_presign" || cdnBaseUrl) {
      sourceFetchers.push({ id: `signed:${cdnBaseUrl || signModeRaw}`, presign: (k, t) => storage.presignGet(k, t) });
    }
  }

  return {
    storage,
    storageConfigured,
    sourceFetchers,
    pollIntervalMs: toInt(pick(values, "worker_poll_interval_ms", "WORKER_POLL_INTERVAL_MS"), 2000),
    leaseMs: toInt(pick(values, "worker_lease_ms", "WORKER_LEASE_MS"), 60_000),
    maxAttempts: toInt(pick(values, "worker_max_attempts", "WORKER_MAX_ATTEMPTS"), 3),
  };
}
