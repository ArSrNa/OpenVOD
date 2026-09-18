// S3 兼容实现（COS / MinIO，ADR-0005）：生产 COS + EO 私有回源；播放 URL 走 EO TypeA，
// 本实现 presign 仅服务于「管理端直传 / 侧信道取回」，不在播放热路径上。
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
  /** CDN 加速域名（.env: CDN_BASE_URL）；EO TypeA 签名由分发端附加 */
  publicBaseUrl?: string;
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
    return getSignedUrl(
      this.client,
      new GetObjectCommand({ Bucket: this.cfg.bucket, Key: this.fullKey(key) }),
      { expiresIn: ttlSec },
    );
  }

  publicUrl(key: string): string {
    const base = (this.cfg.publicBaseUrl ?? "").replace(/\/+$/, "");
    if (!base) throw new Error("CDN_BASE_URL 未配置（EO TypeA 域名，ADR-0005）");
    return `${base}/${this.fullKey(key)}`;
  }
}
