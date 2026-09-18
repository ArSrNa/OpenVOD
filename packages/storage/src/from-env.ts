// 从环境变量构造存储适配器（ADR-0005 / spec.md §1；管理端与 Worker 共用）
// 全局 root 前缀（STORAGE_ROOT_PREFIX）由适配层统一拼接，调用方只用不含 root 的相对键。
import { createStorage, type StorageAdapter, type StorageConfig } from "./index";

export type StorageDriver = "local" | "s3";

/** STORAGE_DRIVER 解析：仅 "s3" 走 S3 兼容实现，其余一律 local */
export function resolveStorageDriver(env: NodeJS.ProcessEnv = process.env): StorageDriver {
  return (env.STORAGE_DRIVER ?? "local") === "s3" ? "s3" : "local";
}

/** .env STORAGE_* / S3_* → StorageAdapter */
export function createStorageFromEnv(env: NodeJS.ProcessEnv = process.env): StorageAdapter {
  const rootPrefix = env.STORAGE_ROOT_PREFIX ?? "";
  const cfg: StorageConfig =
    resolveStorageDriver(env) === "s3"
      ? {
          driver: "s3",
          endpoint: env.S3_ENDPOINT ?? "",
          region: env.S3_REGION ?? "",
          bucket: env.S3_BUCKET ?? "",
          accessKeyId: env.S3_ACCESS_KEY_ID ?? "",
          secretAccessKey: env.S3_SECRET_ACCESS_KEY ?? "",
          // COS（myqcloud）只接受 virtual-hosted-style（<bucket>.cos.<region>.myqcloud.com），
          // 必须显式 S3_FORCE_PATH_STYLE="false"；MinIO 保持默认 true
          forcePathStyle: (env.S3_FORCE_PATH_STYLE ?? "true").trim().toLowerCase() !== "false",
          rootPrefix,
        }
      : {
          driver: "local",
          root: env.STORAGE_LOCAL_ROOT ?? "./data/storage",
          rootPrefix,
        };
  return createStorage(cfg);
}
