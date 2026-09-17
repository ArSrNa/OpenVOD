// EdgeOne URL 鉴权 TypeA（ADR-0005）：
//   sign = timestamp-rand-uid-md5(uri-timestamp-rand-uid-key)
//   URL  = {cdn}/{path}?sign={timestamp}-{rand}-{uid}-{md5hash}
// uri 参与签名 = 路径（以 / 开头，不含 query）；过期由控制台「有效时长」+ timestamp 共同决定，
// 控制台配置与分发端生成必须一致（ADR-0005 TypeA 约定）。
import { createHash, randomBytes } from "node:crypto";

export interface TypeAOptions {
  /** Unix 秒；缺省取当前时间 */
  timestamp?: number;
  /** 缺省随机 8 位 hex；传固定值可提升 CDN 缓存命中率 */
  rand?: string;
  /** 缺省 "0" */
  uid?: string;
}

export interface TypeASignature {
  /** query 参数 sign 的值 */
  sign: string;
  timestamp: number;
}

export function typeAHash(uri: string, timestamp: number, rand: string, uid: string, key: string): string {
  if (!uri.startsWith("/")) throw new Error("TypeA uri 必须以 / 开头");
  if (uri.includes("?")) throw new Error("TypeA uri 不应包含 query");
  const raw = `${uri}-${timestamp}-${rand}-${uid}-${key}`;
  return createHash("md5").update(raw).digest("hex");
}

/** 为播放路径生成 TypeA 签名（CDN 直出，ADR-0005 分片服务路径） */
export function signTypeA(path: string, key: string, opts: TypeAOptions = {}): TypeASignature {
  const timestamp = opts.timestamp ?? Math.floor(Date.now() / 1000);
  const rand = opts.rand ?? randomBytes(4).toString("hex");
  const uid = opts.uid ?? "0";
  const hash = typeAHash(path, timestamp, rand, uid, key);
  return { sign: `${timestamp}-${rand}-${uid}-${hash}`, timestamp };
}

/** 拼接完整签名 URL */
export function typeAUrl(baseUrl: string, path: string, key: string, opts: TypeAOptions = {}): string {
  const base = baseUrl.replace(/\/+$/, "");
  const { sign } = signTypeA(path, key, opts);
  return `${base}${path}?sign=${sign}`;
}
