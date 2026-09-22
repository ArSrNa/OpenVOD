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
    const raw = part.trim();
    const seg = raw.split(":");
    const verRaw = seg[0];
    const hex = seg.length > 1 ? seg.slice(1).join(":") : "";
    const ver = Number(verRaw);
    const key = Buffer.from(hex, "hex");
    if (!Number.isInteger(ver) || ver <= 0 || key.length !== 32) {
      // 报「形态」不报内容：该消息会进向导页 / 启动日志 / API 响应，
      // 密钥值绝不能出现在任何输出里（ADR-0006 红线）。只在确为 1–3 位数字时回显版本号。
      const verText = /^[0-9]{1,3}$/.test(verRaw ?? "") ? `版本=${verRaw}` : "版本段不是 1–3 位正整数";
      const hexText = hex === "" ? "缺少「版本:」分隔符" : `密钥段长度 ${hex.length}（应为 64 位 hex）`;
      throw new Error(`MASTER_KEYS 片段非法（应为 "版本:64位hex"，32 字节密钥）：${verText}，${hexText}`);
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
