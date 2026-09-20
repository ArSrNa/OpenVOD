// 字幕轨道的生产依赖（Prisma + 对象存储）与错误响应（spec.md §7.4；ADR-0009）。
// 业务规则在 ./subtitle-tracks（纯编排、可单测）；本文件只做接线，勿在此写规则。
import { SUBTITLE_CONTENT_TYPE, generateSubtitleTrackId } from "@openvod/shared";
import { getDb } from "@openvod/db";
import { NextResponse } from "next/server";
import { apiError } from "./envelope";
import { getStorage } from "./storage";
import {
  SubtitleError,
  type SubtitleCreateData,
  type SubtitleDeps,
  type SubtitleRow,
  type SubtitleUpdateData,
} from "./subtitle-tracks";

export * from "./subtitle-tracks";

const db = (): any => getDb<any>();

function isUniqueViolation(e: unknown): boolean {
  return (e as { code?: string }).code === "P2002";
}

function mapRow(r: any): SubtitleRow {
  return {
    id: r.id,
    mediaId: r.mediaId,
    lang: r.lang,
    label: r.label,
    isDefault: r.isDefault,
    status: r.status,
    storageKey: r.storageKey,
    bytes: r.bytes,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

export const defaultSubtitleDeps: SubtitleDeps = {
  mediaExists: async (mediaId) =>
    Boolean(await db().media.findUnique({ where: { id: mediaId }, select: { id: true } })),

  listTracks: async (mediaId) => {
    const rows = await db().mediaSubtitle.findMany({
      where: { mediaId },
      orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }],
    });
    return (rows as any[]).map(mapRow);
  },

  findTrack: async (mediaId, trackId) => {
    const row = await db().mediaSubtitle.findFirst({ where: { id: trackId, mediaId } });
    return row ? mapRow(row) : null;
  },

  findTrackByLang: async (mediaId, lang) => {
    const row = await db().mediaSubtitle.findFirst({ where: { mediaId, lang } });
    return row ? mapRow(row) : null;
  },

  hasTracks: async (mediaId) => (await db().mediaSubtitle.count({ where: { mediaId } })) > 0,

  createTrack: async (data: SubtitleCreateData) => {
    try {
      // 默认轨唯一性靠事务：MySQL / SQLite 均无部分唯一索引（spec.md §7.1）
      const row = await db().$transaction(async (tx: any) => {
        if (data.isDefault) {
          await tx.mediaSubtitle.updateMany({
            where: { mediaId: data.mediaId },
            data: { isDefault: false },
          });
        }
        return tx.mediaSubtitle.create({
          data: {
            id: data.id,
            mediaId: data.mediaId,
            lang: data.lang,
            label: data.label,
            isDefault: data.isDefault,
            status: "READY", // v1 上传同步校验：校验通过即就绪（spec.md §7.1）
            storageKey: data.storageKey,
            bytes: data.bytes,
            createdBy: data.createdBy,
          },
        });
      });
      return mapRow(row);
    } catch (e) {
      if (isUniqueViolation(e)) {
        throw new SubtitleError("bad_request", `该媒资已存在 ${data.lang} 语言的字幕轨道`, 409);
      }
      throw e;
    }
  },

  updateTrack: async (id, mediaId, data: SubtitleUpdateData, makeDefault: boolean) => {
    const row = await db().$transaction(async (tx: any) => {
      if (makeDefault) {
        await tx.mediaSubtitle.updateMany({
          where: { mediaId, NOT: { id } },
          data: { isDefault: false },
        });
      }
      return tx.mediaSubtitle.update({ where: { id }, data });
    });
    return mapRow(row);
  },

  deleteTrack: async (id) => {
    await db().mediaSubtitle.delete({ where: { id } });
  },

  newTrackId: () => generateSubtitleTrackId(),

  putObject: async (key, bytes) => {
    await getStorage().put(key, bytes, SUBTITLE_CONTENT_TYPE);
  },

  getObject: async (key) => getStorage().get(key),

  deleteObject: async (key) => {
    try {
      await getStorage().delete(key);
    } catch {
      // 删除幂等：对象已不存在等异常不阻断（spec.md §7.2）
    }
  },

  objectExists: async (key) => {
    try {
      return Boolean(await getStorage().stat(key));
    } catch {
      return null; // 存储不可用 → storage_ok = null（列表仍可用）
    }
  },
};

/** 业务错误 → 统一错误信封响应 */
export function subtitleErrorResponse(e: unknown): NextResponse {
  if (e instanceof SubtitleError) return apiError(e.code, e.message, e.status);
  console.error("[subtitles] unexpected error:", e);
  return apiError("internal", (e as Error)?.message ?? "内部错误", 500);
}
