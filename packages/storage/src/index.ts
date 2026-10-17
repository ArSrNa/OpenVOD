// 统一存储适配层（ADR-0005 / spec.md §1）：S3 兼容对象存储（COS、MinIO 等）
// 2026-09-22 修订：不再提供本地文件系统驱动，仅 S3（见 ADR-0005 修订记录）。
// 键布局见 @openvod/shared STORAGE_KEYS；全局 root 前缀（STORAGE_ROOT_PREFIX）由本层
// rootPrefix 配置统一拼接——调用方出入参均为不含 root 的相对键；
// 密钥材料绝不入对象存储（ADR-0005）。
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
  /** 流式上传（原视频直传等大文件路径，M1 管理端上传用；避免文件整体进内存） */
  putStream(key: string, body: ReadableStream, contentType?: string): Promise<void>;
  get(key: string): Promise<Uint8Array>;
  stat(key: string): Promise<StatResult | null>;
  delete(key: string): Promise<void>;
  list(prefix: string): Promise<string[]>;
  /** 列举对象（含 size / lastModified）；与 list 相同：入参出参均为相对键 */
  listObjects(prefix: string): Promise<StorageObject[]>;
  /** 上传预签名（管理端直传用，ADR-0005 上传路径） */
  presignPut(key: string, ttlSec: number): Promise<string>;
  /** 下载预签名（管理侧取回源片 / 分片直出；可经 STORAGE_CDN_BASE_URL 替换 origin，ADR-0005） */
  presignGet(key: string, ttlSec: number): Promise<string>;
}

export type StorageConfig = { driver: "s3" } & S3Config;

export function createStorage(cfg: StorageConfig): StorageAdapter {
  return new S3Adapter(cfg);
}

export { withRootPrefix, relativeTo } from "./prefix";
export { S3Adapter, type S3Config } from "./s3";
export { createStorageFromEnv, createStorageFromConfig } from "./from-env";
export {
  type SignMode,
  type UrlSigner,
  type UrlSignerFactoryDeps,
  type EdgeOneSignerOptions,
  type EdgeOneTypeASignerOptions,
  createUrlSigner,
  createEdgeOneSigner,
  createEdgeOneTypeASigner,
  typeAWindowTimestamp,
  registerUrlSigner,
  getRegisteredUrlSignerFactory,
  TYPEA_FIXED_RAND,
  TYPEA_FIXED_UID,
} from "./signer";
export { STORAGE_SIGN_MODES, CDN_AUTH_TYPES } from "@openvod/shared";
// 自定义签名提供者注册入口（ADR-0019）：导入即执行用户侧 registerUrlSigner
import "./custom-signer";
