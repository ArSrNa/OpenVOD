// 管理端存储实例工厂（服务端专用）：.env STORAGE_* → StorageAdapter
// 全局 root 前缀（STORAGE_ROOT_PREFIX，spec.md §1.1）由适配层统一拼接，
// 业务代码（键常量 / 调用方）只写不含 root 的相对键。
import { createStorage, type StorageAdapter, type StorageConfig } from "@openvod/storage";

export function getStorage(): StorageAdapter {
  const rootPrefix = process.env.STORAGE_ROOT_PREFIX ?? "";
  const cfg: StorageConfig =
    (process.env.STORAGE_DRIVER ?? "local") === "s3"
      ? {
          driver: "s3",
          endpoint: process.env.S3_ENDPOINT ?? "",
          region: process.env.S3_REGION ?? "",
          bucket: process.env.S3_BUCKET ?? "",
          accessKeyId: process.env.S3_ACCESS_KEY_ID ?? "",
          secretAccessKey: process.env.S3_SECRET_ACCESS_KEY ?? "",
          // COS（myqcloud）只接受 virtual-hosted-style（<bucket>.cos.<region>.myqcloud.com），
          // 必须显式 S3_FORCE_PATH_STYLE="false"；MinIO 保持默认 true
          forcePathStyle: (process.env.S3_FORCE_PATH_STYLE ?? "true").trim().toLowerCase() !== "false",
          rootPrefix,
        }
      : {
          driver: "local",
          root: process.env.STORAGE_LOCAL_ROOT ?? "./data/storage",
          rootPrefix,
        };
  return createStorage(cfg);
}
