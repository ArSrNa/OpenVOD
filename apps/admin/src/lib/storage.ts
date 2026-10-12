// 管理端存储实例工厂（服务端专用）：委托 @openvod/storage 的统一实现，避免与 Worker 漂移。
// ADR-0015：配置来自 system_settings（首次启动向导写入，env 兜底），30s 快照缓存；
// 全局 root 前缀（STORAGE_ROOT_PREFIX，spec.md §1.1）由适配层统一拼接，
// 业务代码（键常量 / 调用方）只写不含 root 的相对键。
// 2026-09-22 修订（ADR-0005）：仅 S3 兼容存储，local 驱动已移除。
import { createStorageFromConfig, type SignMode, type StorageAdapter } from "@openvod/storage";

import { getSettingsSnapshot } from "./settings";

/** 存储实例缓存：配置（快照）变化时重建 */
let cached: { adapter: StorageAdapter; fingerprint: string } | null = null;

export async function getStorage(): Promise<StorageAdapter> {
  const s = (await getSettingsSnapshot()).storage;
  const fingerprint = [
    s.endpoint,
    s.region,
    s.bucket,
    s.accessKeyId,
    s.secretAccessKey,
    s.forcePathStyle,
    s.cdnBaseUrl,
    s.rootPrefix,
    // 签名方式（ADR-0019）：模式 / 密钥 / 窗口 / 自定义提供者任一变化即重建
    s.signMode,
    s.cdnAuthKey,
    s.cdnAuthTtlSec,
    s.customSigner,
  ].join("|");
  if (!cached || cached.fingerprint !== fingerprint) {
    cached = {
      adapter: createStorageFromConfig({
        endpoint: s.endpoint,
        region: s.region,
        bucket: s.bucket,
        accessKeyId: s.accessKeyId,
        secretAccessKey: s.secretAccessKey,
        forcePathStyle: s.forcePathStyle,
        cdnBaseUrl: s.cdnBaseUrl,
        rootPrefix: s.rootPrefix,
        signMode: s.signMode as SignMode,
        cdnAuthKey: s.cdnAuthKey,
        cdnAuthTtlSec: s.cdnAuthTtlSec,
        customSignerName: s.customSigner,
      }),
      fingerprint,
    };
  }
  return cached.adapter;
}
