// MK 主密钥 + AES-256-GCM 封装（ADR-0006 §1/§2）
// wrapped 布局：iv(12B) || ciphertext || tag(16B)；明文敏感材料（CEK / JWT 私钥 / TypeA 密钥）永不落库。
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export interface MasterKey {
  ver: number;
  key: Buffer; // 32B
}

/** 环境变量格式："1:<64 hex>,2:<64 hex>"（多版本支持轮换重封装，ADR-0006 §6） */
export function parseMasterKeys(env: string | undefined): MasterKey[] {
  if (!env?.trim()) throw new Error("MASTER_KEYS 未配置（见 .env.example）");
  return env.split(",").map((part) => {
    const [verRaw, hex] = part.trim().split(":");
    const ver = Number(verRaw);
    const key = Buffer.from(hex ?? "", "hex");
    if (!Number.isInteger(ver) || ver <= 0 || key.length !== 32) {
      throw new Error(`MASTER_KEYS 片段非法："${part.trim()}"（应为 "版本:64位hex"，32 字节密钥）`);
    }
    return { ver, key };
  });
}

/** 内容密钥 CEK：16B（HLS AES-128，ADR-0006） */
export function genCek(): Buffer {
  return randomBytes(16);
}

/** 播放清单显式 IV：16B（ADR-0006 §1） */
export function genMediaIV(): Buffer {
  return randomBytes(16);
}

function gcmIV(): Buffer {
  return randomBytes(12);
}

/** AES-256-GCM 封装：返回 iv(12B) || ct || tag(16B) */
export function wrap(mk: Buffer, plaintext: Buffer, opts?: { iv?: Buffer }): Buffer {
  if (mk.length !== 32) throw new Error("MK 必须为 32 字节");
  const iv = opts?.iv ?? gcmIV();
  const cipher = createCipheriv("aes-256-gcm", mk, iv);
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([iv, ct, cipher.getAuthTag()]);
}

/** AES-256-GCM 解封；输入损坏或密钥不符时抛错（GCM 自带认证） */
export function unwrap(mk: Buffer, wrapped: Buffer): Buffer {
  const iv = wrapped.subarray(0, 12);
  const tag = wrapped.subarray(wrapped.length - 16);
  const ct = wrapped.subarray(12, wrapped.length - 16);
  const decipher = createDecipheriv("aes-256-gcm", mk, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]);
}
