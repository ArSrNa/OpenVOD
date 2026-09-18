// 统一存储适配层（ADR-0005 / spec.md §1）：local / s3（COS、MinIO 等 S3 兼容实现）
// 键布局见 @openvod/shared STORAGE_KEYS；全局 root 前缀（STORAGE_ROOT_PREFIX）由本层
// rootPrefix 配置统一拼接——调用方出入参均为不含 root 的相对键；
// 密钥材料绝不入对象存储（ADR-0005）。
import { LocalAdapter, type LocalConfig } from "./local";
import { S3Adapter, type S3Config } from "./s3";

export interface StatResult {
  size: number;
}

/** listObjects 条目：相对键 + 元信息（媒资列表等管理侧场景用） */
export interface StorageObject {
  key: string;
  size: number;
  lastModified?: Date;
}

export interface StorageAdapter {
  put(key: string, data: Uint8Array | string, contentType?: string): Promise<void>;
  get(key: string): Promise<Uint8Array>;
  stat(key: string): Promise<StatResult | null>;
  delete(key: string): Promise<void>;
  list(prefix: string): Promise<string[]>;
  /** 列举对象（含 size / lastModified）；与 list 相同：入参出参均为相对键 */
  listObjects(prefix: string): Promise<StorageObject[]>;
  /** 上传预签名（管理端直传用，ADR-0005 上传路径；local 模式不支持） */
  presignPut(key: string, ttlSec: number): Promise<string>;
  /** 下载预签名（管理侧取回源片用；播放分发不走这里，走 EO TypeA，ADR-0005） */
  presignGet(key: string, ttlSec: number): Promise<string>;
  /** 经 CDN 域名的公开拼接（配合 EO TypeA 签名使用） */
  publicUrl(key: string): string;
}

export type StorageConfig =
  | ({ driver: "local" } & LocalConfig)
  | ({ driver: "s3" } & S3Config);

export function createStorage(cfg: StorageConfig): StorageAdapter {
  switch (cfg.driver) {
    case "local":
      return new LocalAdapter(cfg);
    case "s3":
      return new S3Adapter(cfg);
  }
}

export { LocalAdapter, type LocalConfig } from "./local";
export { withRootPrefix, relativeTo } from "./prefix";
export { S3Adapter, type S3Config } from "./s3";
