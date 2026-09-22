// S3 兼容实现（COS / MinIO 等，ADR-0005）：唯一的存储驱动。
// presign 服务于管理端直传 / 预览 302、Worker 取源片与播放分片预签名直出（字节不经过分发端）。
import {
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  HeadObjectCommand,
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { Readable } from "node:stream";
import type { StorageAdapter, StorageObject, StatResult } from "./index";
import { withRootPrefix } from "./prefix";

export interface S3Config {
  endpoint: string; // .env: S3_ENDPOINT（COS: https://cos.<region>.myqcloud.com）
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** 全局 root 前缀（.env: STORAGE_ROOT_PREFIX，spec.md §1.1）；空 = 桶顶层 */
  rootPrefix?: string;
  /** CDN 加速域名（.env: STORAGE_CDN_BASE_URL）——**只替换 GET 预签名 URL 的 origin**（管理端预览 302 /
   *  presign 分片直出）；上传预签名（presignPut）恒走存储端点。前提：CDN 回源 COS 且 Host 透传/改写为桶端点，
   *  SigV4 签名覆盖 Host，域名替换后源站才能验签通过（ADR-0005 统一加速域名方案） */
  cdnBaseUrl?: string;
  forcePathStyle?: boolean; // MinIO: true
}

export class S3Adapter implements StorageAdapter {
  private client: S3Client;

  constructor(private cfg: S3Config) {
    this.client = new S3Client({
      endpoint: cfg.endpoint || undefined,
      region: cfg.region,
      credentials: {
        accessKeyId: cfg.accessKeyId,
        secretAccessKey: cfg.secretAccessKey,
      },
      forcePathStyle: cfg.forcePathStyle ?? true,
    });
  }

  /** 相对键 → 完整键（拼全局 root 前缀，spec.md §1.1） */
  private fullKey(key: string): string {
    return withRootPrefix(this.cfg.rootPrefix, key);
  }

  async put(key: string, data: Uint8Array | string, contentType?: string): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.cfg.bucket,
        Key: this.fullKey(key),
        Body: typeof data === "string" ? Buffer.from(data, "utf8") : Buffer.from(data),
        ContentType: contentType,
      }),
    );
  }

  /** 流式上传：Web ReadableStream → S3 multipart（lib-storage Upload）。
   *  不能用 PutObjectCommand 直发未知长度流：SDK 为流式 body 计算 chunked 签名需要
   *  x-amz-decoded-content-length，取不到会在发送前抛
   *  `Invalid value "undefined" for header "x-amz-decoded-content-length"`（COS 实测复现）。
   *  Upload 按分片 multipart 上传，无需预知长度，天然契合大文件直传（ADR-0005）。 */
  async putStream(key: string, body: ReadableStream, contentType?: string): Promise<void> {
    await new Upload({
      client: this.client,
      params: {
        Bucket: this.cfg.bucket,
        Key: this.fullKey(key),
        Body: Readable.fromWeb(body as unknown as import("node:stream/web").ReadableStream),
        ContentType: contentType,
      },
    }).done();
  }

  async get(key: string): Promise<Uint8Array> {
    const res = await this.client.send(
      new GetObjectCommand({ Bucket: this.cfg.bucket, Key: this.fullKey(key) }),
    );
    return Buffer.from(await res.Body!.transformToByteArray());
  }

  async stat(key: string): Promise<StatResult | null> {
    try {
      const res = await this.client.send(
        new HeadObjectCommand({ Bucket: this.cfg.bucket, Key: this.fullKey(key) }),
      );
      return { size: res.ContentLength ?? 0 };
    } catch {
      return null;
    }
  }

  async delete(key: string): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.cfg.bucket, Key: this.fullKey(key) }),
    );
  }

  async listObjects(prefix: string): Promise<StorageObject[]> {
    const out: StorageObject[] = [];
    // ListObjectsV2 保证返回键以 Prefix 开头：直接按完整前缀切片剥回相对键
    //（rootPrefix 为空时完整前缀即 prefix 本身）
    const fullPrefix = this.fullKey(prefix);
    let token: string | undefined;
    do {
      const res = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.cfg.bucket,
          Prefix: fullPrefix,
          ContinuationToken: token,
        }),
      );
      for (const o of res.Contents ?? []) {
        if (!o.Key || !o.Key.startsWith(fullPrefix)) continue;
        const rel = o.Key.slice(fullPrefix.length);
        if (!rel) continue; // 完整前缀占位对象（如目录占位键）
        out.push({ key: prefix + rel, size: o.Size ?? 0, lastModified: o.LastModified });
      }
      token = res.IsTruncated ? res.NextContinuationToken : undefined;
    } while (token);
    return out;
  }

  async list(prefix: string): Promise<string[]> {
    return (await this.listObjects(prefix)).map((o) => o.key);
  }

  async presignPut(key: string, ttlSec: number): Promise<string> {
    return getSignedUrl(
      this.client,
      new PutObjectCommand({ Bucket: this.cfg.bucket, Key: this.fullKey(key) }),
      { expiresIn: ttlSec },
    );
  }

  async presignGet(key: string, ttlSec: number): Promise<string> {
    const signed = await getSignedUrl(
      this.client,
      new GetObjectCommand({ Bucket: this.cfg.bucket, Key: this.fullKey(key) }),
      { expiresIn: ttlSec },
    );
    return withCdnOrigin(signed, this.cfg.cdnBaseUrl);
  }

}

/** withCdnOrigin 把预签名 URL 的 origin 换成加速域名（路径与签名 query 原样保留）；未配置原样返回 */
function withCdnOrigin(signed: string, cdnBaseUrl?: string): string {
  const base = cdnBaseUrl?.trim().replace(/\/+$/, "");
  if (!base) return signed;
  const u = new URL(signed);
  return base + u.pathname + u.search;
}
