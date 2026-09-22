// 管理端存储实例工厂（服务端专用）：委托 @openvod/storage 的统一实现，避免与 Worker 漂移。
// 全局 root 前缀（STORAGE_ROOT_PREFIX，spec.md §1.1）由适配层统一拼接，
// 业务代码（键常量 / 调用方）只写不含 root 的相对键。
// 2026-09-22 修订（ADR-0005）：仅 S3 兼容存储，local 驱动已移除。
import { createStorageFromEnv } from "@openvod/storage";

export function getStorage() {
  return createStorageFromEnv();
}
