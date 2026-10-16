// EdgeOne Token 鉴权方式 B / C / D / V（ADR-0019；方式 A 见 ./typea.ts）：
// 依据 EO 官方文档（edgeone.ai/zh/document/62476~62479，2026-10 核对）实现，
// 官方示例向量见 fixtures/url-sign-eo-methods-v1.json（TS / Go 共享，防漂移）。
//   B：URL = {base}/{timestamp}/{md5hash}/{path}
//      timestamp = UTC+8 "YYYYMMDDHHMM"（分钟精度）；md5hash = MD5(key + timestamp + path)
//   C：URL = {base}/{md5hash}/{timestamp}/{path}
//      timestamp = 十六进制 Unix 秒（小写、无 0x 前缀）；md5hash = MD5(key + path + timestamp)
//   D：URL = {base}/{path}?token={md5hash}&t={timestamp}
//      timestamp = 十进制 Unix 秒；md5hash = MD5(key + path + timestamp)
//   V：URL = {base}/{path}?t={t}&sign={sign}（TypeV 视频增强）
//      t = 十六进制 Unix 秒（URL 过期时刻，非签发时刻）；
//      sign = sha1(key + path + t + plive + exper + us + whref + bkref + whip + bkip)（顺序固定、选填空串）
// 约定：path 均以 / 开头、不含 query（B/C 的鉴权前缀由 EO 节点验签通过后剥离回源）；
// A/B/C/D 的 timestamp 语义为「签发时刻」（有效期从它起算，等于控制台「有效时长」）。
import { createHash } from "node:crypto";

import { CDN_AUTH_TYPES, type CdnAuthType } from "@openvod/shared";

/** EO Token 鉴权方式（storage_cdn_auth_type；与 EO 控制台 Token 鉴权「鉴权方式」一致） */
export type EdgeOneAuthType = CdnAuthType;

export function isEdgeOneAuthType(v: string): v is CdnAuthType {
  return (CDN_AUTH_TYPES as readonly string[]).includes(v);
}

const md5Hex = (raw: string) => createHash("md5").update(raw).digest("hex");
const sha1Hex = (raw: string) => createHash("sha1").update(raw).digest("hex");

/** Unix 秒 → UTC+8 的 "YYYYMMDDHHMM"（方式 B；纯算术实现，不依赖进程时区） */
export function utc8MinuteString(tsSec: number): string {
  return new Date((tsSec + 8 * 3600) * 1000)
    .toISOString()
    .slice(0, 16)
    .replace(/[-T:]/g, "");
}

/** B：md5hash = MD5(key + timestamp + path)（timestamp 为 UTC+8 分钟串） */
export function typeBHash(path: string, timestampUtc8: string, key: string): string {
  return md5Hex(`${key}${timestampUtc8}${path}`);
}

/** C：md5hash = MD5(key + path + timestamp)（timestamp 为十六进制 Unix 秒，无 0x） */
export function typeCHash(path: string, timestampHex: string, key: string): string {
  return md5Hex(`${key}${path}${timestampHex}`);
}

/** D：md5hash = MD5(key + path + timestamp)（timestamp 为十进制 Unix 秒） */
export function typeDHash(path: string, timestampDecimal: string, key: string): string {
  return md5Hex(`${key}${path}${timestampDecimal}`);
}

/** 方式 V 的签名参数：t 必填（过期时刻，十六进制 Unix 秒）；其余选填，缺省按空串参与拼接 */
export interface TypeVParams {
  t: string;
  plive?: string;
  exper?: string;
  us?: string;
  whref?: string;
  bkref?: string;
  whip?: string;
  bkip?: string;
}

/** V：sign = sha1(key + path + t + plive + exper + us + whref + bkref + whip + bkip)（顺序固定、不可调换） */
export function typeVHash(path: string, key: string, p: TypeVParams): string {
  const raw = [key, path, p.t, p.plive, p.exper, p.us, p.whref, p.bkref, p.whip, p.bkip]
    .map((s) => s ?? "")
    .join("");
  return sha1Hex(raw);
}

export interface EdgeOneUrlOptions {
  /** A/B/C/D 为签发时刻对齐值（Unix 秒）；V 为过期时刻（签名器按窗口 +1 后传入） */
  timestampSec: number;
}

const trimBase = (baseUrl: string) => baseUrl.replace(/\/+$/, "");

/** B：{base}/{timestamp}/{md5hash}/{path} */
export function typeBUrl(baseUrl: string, path: string, key: string, opts: EdgeOneUrlOptions): string {
  const ts = utc8MinuteString(opts.timestampSec);
  return `${trimBase(baseUrl)}/${ts}/${typeBHash(path, ts, key)}${path}`;
}

/** C：{base}/{md5hash}/{timestamp}/{path} */
export function typeCUrl(baseUrl: string, path: string, key: string, opts: EdgeOneUrlOptions): string {
  const ts = opts.timestampSec.toString(16);
  return `${trimBase(baseUrl)}/${typeCHash(path, ts, key)}/${ts}${path}`;
}

/** D：{base}/{path}?token={md5hash}&t={timestamp}（token / t 为官方默认参数名；控制台自定义时须与本实现一致） */
export function typeDUrl(baseUrl: string, path: string, key: string, opts: EdgeOneUrlOptions): string {
  const ts = String(opts.timestampSec);
  return `${trimBase(baseUrl)}${path}?token=${typeDHash(path, ts, key)}&t=${ts}`;
}

/** V：{base}/{path}?t={t}&sign={sign}（本实现不生成 plive/exper/us 等选填参数：
 *  非 VOD 源站不支持 us / plive；试看（exper）与 Referer/IP 限制按需再扩展） */
export function typeVUrl(baseUrl: string, path: string, key: string, opts: EdgeOneUrlOptions): string {
  const t = opts.timestampSec.toString(16);
  return `${trimBase(baseUrl)}${path}?t=${t}&sign=${typeVHash(path, key, { t })}`;
}
