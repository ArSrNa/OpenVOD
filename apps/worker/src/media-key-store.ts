// hls_keys 持久化（每媒资一份，spec.md §4.1/§4.2）
//
// 关键语义：**事务内整行替换**。`hls_keys.media_id` 有唯一约束，因此不可能「先插新行再删旧行」；
// 必须同一事务内先删后插 —— 这样既满足唯一约束，又保证：
//   · 任一步失败 → 整个事务回滚，**旧密钥行原样保留**（不会出现既无新也无旧的空洞）；
//   · 成功 → 旧 kid 立即失效，媒资始终只有一行密钥。
import { getDb } from "@openvod/db";

/** 密钥行的持久化形态（明文 CEK 不在其中，ADR-0006） */
export interface MediaKeyRecord {
  kid: string;
  method: string;
  /** 显式 IV（纯 hex，无 0x；DB 列 `iv`） */
  ivHex: string;
  /** MK(AES-256-GCM) 封装的 CEK（hex；DB 列 `wrapped_cek`） */
  wrappedCekHex: string;
  mkVer: number;
}

export interface MediaKeyStore {
  /** 整行替换该媒资的密钥行；返回是否替换掉了既有行 */
  replace(mediaId: string, record: MediaKeyRecord): Promise<{ replaced: boolean }>;
  /** 读取该媒资当前密钥行（无则 null） */
  find(mediaId: string): Promise<(MediaKeyRecord & { createdAt: Date }) | null>;
}

/** Prisma 实现（MySQL 生产 / SQLite 开发，ADR-0004） */
export function createPrismaMediaKeyStore(): MediaKeyStore {
  const db = getDb<any>();

  return {
    async replace(mediaId, record) {
      const existing = await db.hlsKey.findUnique({
        where: { mediaId },
        select: { id: true },
      });
      await db.$transaction([
        db.hlsKey.deleteMany({ where: { mediaId } }),
        db.hlsKey.create({
          data: {
            mediaId,
            kid: record.kid,
            method: record.method,
            // Prisma 字段名与 record 命名不同：列 iv ← record.ivHex，列 wrapped_cek ← record.wrappedCekHex
            iv: record.ivHex,
            wrappedCek: record.wrappedCekHex,
            mkVer: record.mkVer,
          },
        }),
      ]);
      return { replaced: Boolean(existing) };
    },

    async find(mediaId) {
      const row = await db.hlsKey.findUnique({ where: { mediaId } });
      if (!row) return null;
      return {
        kid: row.kid,
        method: row.method,
        ivHex: row.iv,
        wrappedCekHex: row.wrappedCek,
        mkVer: row.mkVer,
        createdAt: row.createdAt,
      };
    },
  };
}
