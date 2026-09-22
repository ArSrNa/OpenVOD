// 从环境变量构造存储适配器（ADR-0005 / spec.md §1；管理端与 Worker 共用）
// 全局 root 前缀（STORAGE_ROOT_PREFIX）由适配层统一拼接，调用方只用不含 root 的相对键。
// 2026-09-22 修订（ADR-0005）：仅支持 S3 兼容对象存储（COS / MinIO 等），本地文件系统驱动已移除。
import { createStorage, type StorageAdapter, type StorageConfig } from "./index";

/** .env STORAGE_* / S3_* → StorageAdapter */
export function createStorageFromEnv(env: NodeJS.ProcessEnv = process.env): StorageAdapter {
  const rootPrefix = env.STORAGE_ROOT_PREFIX ?? "";
  const cfg: StorageConfig = {
    driver: "s3",
    endpoint: env.S3_ENDPOINT ?? "",
    region: env.S3_REGION ?? "",
    bucket: env.S3_BUCKET ?? "",
    accessKeyId: env.S3_ACCESS_KEY_ID ?? "",
    secretAccessKey: env.S3_SECRET_ACCESS_KEY ?? "",
    // COS（myqcloud）只接受 virtual-hosted-style（<bucket>.cos.<region>.myqcloud.com），
    // 必须显式 S3_FORCE_PATH_STYLE="false"；MinIO 保持默认 true
    forcePathStyle: (env.S3_FORCE_PATH_STYLE ?? "true").trim().toLowerCase() !== "false",
    // 加速域名（ADR-0005 统一加速域名方案）：GET 预签名 origin 替换（管理端预览 / presign 分片）
    cdnBaseUrl: env.STORAGE_CDN_BASE_URL || undefined,
    rootPrefix,
  };
  return createStorage(cfg);
}
