// 从环境变量 / 显式配置构造存储适配器（ADR-0005 / spec.md §1；管理端与 Worker 共用）
// 全局 root 前缀（STORAGE_ROOT_PREFIX）由适配层统一拼接，调用方只用不含 root 的相对键。
// 2026-09-22 修订（ADR-0005）：仅支持 S3 兼容对象存储（COS / MinIO 等），本地文件系统驱动已移除。
// ADR-0015：新增 createStorageFromConfig —— 配置可来自 system_settings（首次启动向导写入），
// env 只作兜底；createStorageFromEnv 保留为 env 兜底路径。
import { createStorage, type StorageAdapter, type StorageConfig } from "./index";
import { type SignMode } from "./signer";
import { STORAGE_SIGN_MODES } from "@openvod/shared";

/** 显式配置 → StorageAdapter（ADR-0015：admin / worker 从 system_settings 解析后传入） */
export function createStorageFromConfig(cfg: Partial<StorageConfig>): StorageAdapter {
  return createStorage({
    driver: "s3",
    endpoint: cfg.endpoint ?? "",
    region: cfg.region ?? "",
    bucket: cfg.bucket ?? "",
    accessKeyId: cfg.accessKeyId ?? "",
    secretAccessKey: cfg.secretAccessKey ?? "",
    // COS（myqcloud）只接受 virtual-hosted-style（<bucket>.cos.<region>.myqcloud.com），
    // 必须显式 force_path_style=false；MinIO 保持默认 true
    forcePathStyle: cfg.forcePathStyle ?? true,
    // 加速域名（ADR-0005 / ADR-0019）：s3_presign 下替换预签名 origin；cdn_url_auth 下为签名 host
    cdnBaseUrl: cfg.cdnBaseUrl || undefined,
    rootPrefix: cfg.rootPrefix ?? "",
    // GET 签名方式（ADR-0019）：s3_presign（默认，现状）/ cdn_url_auth / custom
    signMode: normalizeSignMode(cfg.signMode),
    cdnAuthKey: cfg.cdnAuthKey || undefined,
    // EO Token 鉴权方式（a | b | c | d | v，默认 a）：与 CDN 控制台 Token 鉴权所选方式一致
    cdnAuthType: cfg.cdnAuthType || undefined,
    // 方式 A 的鉴权参数名（storage_cdn_auth_param，默认 sign）
    cdnAuthParam: cfg.cdnAuthParam || undefined,
    cdnAuthTtlSec: cfg.cdnAuthTtlSec,
    customSignerName: cfg.customSignerName || undefined,
  });
}

function normalizeSignMode(mode: Partial<StorageConfig>["signMode"]): SignMode {
  const raw = (mode ?? "").trim();
  if (!raw) return "s3_presign";
  if ((STORAGE_SIGN_MODES as readonly string[]).includes(raw)) return raw as SignMode;
  throw new Error(`storage_sign_mode 非法：${raw}（可选 ${STORAGE_SIGN_MODES.join(" | ")}，ADR-0019）`);
}

/** .env STORAGE_* / S3_* → StorageAdapter（env 兜底路径；DB 设置优先时勿用） */
export function createStorageFromEnv(env: NodeJS.ProcessEnv = process.env): StorageAdapter {
  return createStorageFromConfig({
    endpoint: env.S3_ENDPOINT ?? "",
    region: env.S3_REGION ?? "",
    bucket: env.S3_BUCKET ?? "",
    accessKeyId: env.S3_ACCESS_KEY_ID ?? "",
    secretAccessKey: env.S3_SECRET_ACCESS_KEY ?? "",
    forcePathStyle: (env.S3_FORCE_PATH_STYLE ?? "true").trim().toLowerCase() !== "false",
    cdnBaseUrl: env.STORAGE_CDN_BASE_URL || "",
    rootPrefix: env.STORAGE_ROOT_PREFIX ?? "",
    signMode: (env.STORAGE_SIGN_MODE || "") as SignMode,
    cdnAuthKey: env.STORAGE_CDN_AUTH_KEY || "",
    cdnAuthType: env.STORAGE_CDN_AUTH_TYPE || "",
    cdnAuthParam: env.STORAGE_CDN_AUTH_PARAM || "",
    cdnAuthTtlSec: env.STORAGE_CDN_AUTH_TTL_SEC ? Number(env.STORAGE_CDN_AUTH_TTL_SEC) : undefined,
    customSignerName: env.STORAGE_CUSTOM_SIGNER || "",
  });
}
