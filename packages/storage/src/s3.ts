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
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { StorageAdapter, StatResult } from "./index";

export interface S3Config {
  endpoint: string; // .env: S3_ENDPOINT（COS: https://cos.<region>.myqcloud.com）
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
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

  async put(key: string, data: Uint8Array | string, contentType?: string): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.cfg.bucket,
        Key: key,
        Body: typeof data === "string" ? Buffer.from(data, "utf8") : Buffer.from(data),
        ContentType: contentType,
      }),
    );
  }

  async get(key: string): Promise<Uint8Array> {
    const res = await this.client.send(new GetObjectCommand({ Bucket: this.cfg.bucket, Key: key }));
    return Buffer.from(await res.Body!.transformToByteArray());
  }

  async stat(key: string): Promise<StatResult | null> {
    try {
      const res = await this.client.send(new HeadObjectCommand({ Bucket: this.cfg.bucket, Key: key }));
      return { size: res.ContentLength ?? 0 };
    } catch {
      return null;
    }
  }

  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.cfg.bucket, Key: key }));
  }

  async list(prefix: string): Promise<string[]> {
    const out: string[] = [];
    let token: string | undefined;
    do {
      const res = await this.client.send(
        new ListObjectsV2Command({ Bucket: this.cfg.bucket, Prefix: prefix, ContinuationToken: token }),
      );
      for (const o of res.Contents ?? []) if (o.Key) out.push(o.Key);
      token = res.IsTruncated ? res.NextContinuationToken : undefined;
    } while (token);
    return out;
  }

  async presignPut(key: string, ttlSec: number): Promise<string> {
    return getSignedUrl(
      this.client,
      new PutObjectCommand({ Bucket: this.cfg.bucket, Key: key }),
      { expiresIn: ttlSec },
    );
  }

  async presignGet(key: string, ttlSec: number): Promise<string> {
    return getSignedUrl(
      this.client,
      new GetObjectCommand({ Bucket: this.cfg.bucket, Key: key }),
      { expiresIn: ttlSec },
    );
  }

  publicUrl(key: string): string {
    const base = (this.cfg.publicBaseUrl ?? "").replace(/\/+$/, "");
    if (!base) throw new Error("CDN_BASE_URL 未配置（EO TypeA 域名，ADR-0005）");
    return `${base}/${key}`;
  }
}
