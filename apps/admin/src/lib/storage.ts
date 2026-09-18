// 管理端存储实例工厂（服务端专用）：委托 @openvod/storage 的统一实现，避免与 Worker 漂移。
// 全局 root 前缀（STORAGE_ROOT_PREFIX，spec.md §1.1）由适配层统一拼接，
// 业务代码（键常量 / 调用方）只写不含 root 的相对键。
import { createStorageFromEnv, resolveStorageDriver, type StorageDriver } from "@openvod/storage";

export type { StorageDriver };

export function getStorageDriver(): StorageDriver {
  return resolveStorageDriver();
}

export function getStorage() {
  return createStorageFromEnv();
}
