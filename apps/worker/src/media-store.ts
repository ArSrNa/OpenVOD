// 媒资读模型与状态回写（Worker 视角，spec.md §1/§2；ADR-0008）
// Worker 只碰 media 的状态 / probe / duration_ms 三处，不写其它字段。
import { getDb } from "@openvod/db";

export type MediaStatusName = "UPLOADED" | "PROBING" | "TRANSCODING" | "READY" | "FAILED" | "ARCHIVED";

export interface MediaRow {
  id: string;
  title: string;
  status: MediaStatusName;
  sourceKey: string | null;
}

export interface MediaStore {
  get(id: string): Promise<MediaRow | null>;
  setStatus(id: string, status: MediaStatusName): Promise<void>;
  /** 回写 ffprobe 摘要与时长（管理端「生成元数据」同源字段） */
  saveProbe(id: string, probe: unknown, durationMs: number | null): Promise<void>;
}

export function createPrismaMediaStore(): MediaStore {
  const db = getDb<any>();

  return {
    async get(id) {
      const row = await db.media.findUnique({
        where: { id },
        select: { id: true, title: true, status: true, sourceKey: true },
      });
      return row ? { ...row, status: row.status as MediaStatusName } : null;
    },

    async setStatus(id, status) {
      await db.media.update({ where: { id }, data: { status } });
    },

    async saveProbe(id, probe, durationMs) {
      await db.media.update({ where: { id }, data: { probe, durationMs } });
    },
  };
}
