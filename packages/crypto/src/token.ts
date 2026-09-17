// 分发端签名 token（ADR-0006 §4）：
//   token  = b64url(JSON(payload)) + "." + b64url(HMAC-SHA256(signing_key, payload_bytes))
//   payload = { ver, typ, mid, sid, exp, kid }（字段顺序即规范，双端一致）
// 自包含无状态：热路径验签零 DB 往返；typ+mid 防跨媒资重放；sid 绑定会话可吊销。
import { createHmac, timingSafeEqual } from "node:crypto";
import type { TokenType } from "@openvod/shared";

export interface TokenPayload {
  ver: 1;
  typ: TokenType;
  mid: string;
  sid: string;
  /** Unix 秒 */
  exp: number;
  kid: string;
}

export interface SigningKeyEntry {
  kid: string;
  key: Buffer;
}

const b64url = (buf: Buffer) => buf.toString("base64url");

function hmac(payloadBytes: Buffer, key: Buffer): Buffer {
  return createHmac("sha256", key).update(payloadBytes).digest();
}

export function signToken(payload: TokenPayload, key: Buffer): string {
  const payloadBytes = Buffer.from(JSON.stringify(payload), "utf8");
  return `${b64url(payloadBytes)}.${b64url(hmac(payloadBytes, key))}`;
}

export interface VerifyOptions {
  /** 校验 typ（如 key 接口必须 typ=k） */
  typ?: TokenType;
  /** 校验媒资绑定，防跨媒资重放（ADR-0006 威胁模型） */
  mid?: string;
  nowSec?: number;
}

export function verifyToken(
  token: string,
  keys: SigningKeyEntry[],
  opts: VerifyOptions = {},
): TokenPayload {
  const dot = token.indexOf(".");
  if (dot <= 0) throw new Error("bad_token: 格式非法");
  let payloadBytes: Buffer;
  let sig: Buffer;
  try {
    payloadBytes = Buffer.from(token.slice(0, dot), "base64url");
    sig = Buffer.from(token.slice(dot + 1), "base64url");
  } catch {
    throw new Error("bad_token: base64url 解码失败");
  }

  let parsed: TokenPayload;
  try {
    parsed = JSON.parse(payloadBytes.toString("utf8"));
  } catch {
    throw new Error("bad_token: payload 非法");
  }

  const entry = keys.find((k) => k.kid === parsed.kid);
  if (!entry) throw new Error(`bad_token: 未知 kid=${parsed.kid}`);
  const expect = hmac(payloadBytes, entry.key);
  if (sig.length !== expect.length || !timingSafeEqual(sig, expect)) {
    throw new Error("bad_token: 签名不匹配");
  }

  const now = opts.nowSec ?? Math.floor(Date.now() / 1000);
  if (parsed.exp <= now) throw new Error("bad_token: 已过期");
  if (opts.typ && parsed.typ !== opts.typ) throw new Error(`bad_token: typ 应为 ${opts.typ}`);
  if (opts.mid && parsed.mid !== opts.mid) throw new Error("bad_token: 媒资绑定不匹配");
  return parsed;
}
