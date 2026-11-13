// 密钥管理业务逻辑（spec.md §4；ADR-0006）
// 「每媒资一份密钥」由 DB 唯一约束（hls_keys.media_id）与事务整行替换共同保证。
//
// P0 红线（spec.md §4.3）：本模块**永不返回明文 CEK**——返回值里只有 kid / method / iv / mk_ver；
// 明文只在 MK 轮换时于内存中短暂解封再封装，不出本文件、不落日志、不进响应。
import {
  ACTIVE_JOB_STATUSES,
  MediaKeyDetail,
  MediaKeyListItem,
  MasterKeyStatus,
  RotateCekRequest,
  RotateCekResponse,
  RotateMasterKeysRequest,
  RotateMasterKeysResponse,
  z,
} from "@openvod/contracts";
import {
  createMediaKey,
  findMasterKey,
  parseMasterKeys,
  pickWrappingMasterKey,
  resealMediaKey,
  type MasterKey,
} from "@openvod/crypto";
import { getDb } from "@openvod/db";
import { MEDIA_ID_CHARS, MEDIA_ID_PATTERN, STORAGE_PARTITIONS } from "@openvod/shared";
import { NextResponse } from "next/server";
import { apiError } from "./api";
import { keyPlanFromMaterial, rotateMediaKeyWithDeps, RotateCekError } from "./keys-rotate";
import { groupProductsByMedia } from "./media-products";
import { templateRowToDto } from "./templates";
import { getWatermark } from "./watermarks";
import { getStorage } from "./storage";

const db = getDb<any>();

/** 业务错误（code 对齐 @openvod/shared ERROR_CODES） */
export class KeyError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

type HlsKeyRow = {
  id: string;
  mediaId: string;
  kid: string;
  method: string;
  iv: string;
  wrappedCekHex: string;
  mkVer: number;
  createdAt: Date;
};

type MediaRow = { id: string; title: string | null; status: string | null };

const PROCEED_RE = new RegExp(`^${STORAGE_PARTITIONS.proceed}/(${MEDIA_ID_CHARS})/`);

/** 读取 MASTER_KEYS（v1 环境变量，ADR-0006 §1）；未配置 / 非法时给出可操作提示 */
function loadMasterKeys(): MasterKey[] {
  try {
    return parseMasterKeys(process.env.MASTER_KEYS);
  } catch (e) {
    throw new KeyError("internal", (e as Error).message, 500);
  }
}

/** 单次列举 proceed 分区，按媒资聚合对象数（存储不可用 → null，不阻塞密钥列表） */
async function countProceedObjects(): Promise<Map<string, number> | null> {
  try {
    const objects = await (await getStorage()).listObjects(`${STORAGE_PARTITIONS.proceed}/`);
    const counts = new Map<string, number>();
    for (const o of objects) {
      const m = PROCEED_RE.exec(o.key);
      if (m) counts.set(m[1], (counts.get(m[1]) ?? 0) + 1);
    }
    return counts;
  } catch (e) {
    console.warn("[keys] proceed 分区列举失败（列表降级）:", (e as Error).message);
    return null;
  }
}

function toItem(
  row: HlsKeyRow,
  media: MediaRow | undefined,
  proceedCounts: Map<string, number> | null,
): z.infer<typeof MediaKeyListItem> {
  return {
    media_id: row.mediaId,
    title: media?.title ?? null,
    media_status: media?.status ?? null,
    kid: row.kid,
    method: row.method,
    mk_ver: row.mkVer,
    created_at: row.createdAt.toISOString(),
    proceed_objects: proceedCounts ? (proceedCounts.get(row.mediaId) ?? 0) : null,
  };
}

async function loadMediaMap(ids: string[]): Promise<Map<string, MediaRow>> {
  if (!ids.length) return new Map();
  const rows: MediaRow[] = await db.media.findMany({
    where: { id: { in: ids } },
    select: { id: true, title: true, status: true },
  });
  return new Map(rows.map((r) => [r.id, r]));
}

/** 媒资 ID 校验（spec.md §1.3：纯数字） */
function assertMediaId(id: string): void {
  if (!MEDIA_ID_PATTERN.test(id)) {
    throw new KeyError("bad_request", `媒资 ID 非法：${id}（应为纯数字，spec.md §1.3）`, 400);
  }
}

// ---- 列表 / 详情 ----

export async function listMediaKeys(): Promise<{
  total: number;
  items: z.infer<typeof MediaKeyListItem>[];
}> {
  const rows: HlsKeyRow[] = await db.hlsKey.findMany({ orderBy: { createdAt: "desc" } });
  const [mediaMap, proceedCounts] = await Promise.all([
    loadMediaMap(rows.map((r) => r.mediaId)),
    countProceedObjects(),
  ]);
  return {
    total: rows.length,
    items: rows.map((row) => toItem(row, mediaMap.get(row.mediaId), proceedCounts)),
  };
}

export async function getMediaKey(mediaId: string): Promise<z.infer<typeof MediaKeyDetail>> {
  assertMediaId(mediaId);
  const row: HlsKeyRow | null = await db.hlsKey.findUnique({ where: { mediaId } });
  if (!row) throw new KeyError("not_found", `该媒资没有密钥（未加密或尚未转码）：${mediaId}`, 404);
  const [mediaMap, proceedCounts] = await Promise.all([
    loadMediaMap([mediaId]),
    countProceedObjects(),
  ]);
  const activeSessions: number = await db.playbackSession
    .count({ where: { mediaId, revokedAt: null, expiresAt: { gt: new Date() } } })
    .catch(() => 0);
  return {
    ...toItem(row, mediaMap.get(mediaId), proceedCounts),
    iv: row.iv,
    active_sessions: activeSessions,
  };
}

// ---- 删除（危险：加密分片将无法解密，需重转码重新生成密钥） ----

export async function deleteMediaKey(mediaId: string): Promise<{ media_id: string }> {
  assertMediaId(mediaId);
  const row: HlsKeyRow | null = await db.hlsKey.findUnique({ where: { mediaId } });
  if (!row) throw new KeyError("not_found", `该媒资没有密钥：${mediaId}`, 404);

  // 存在未吊销且未过期的会话 → 拒绝，避免打断正在播放的会话（spec.md §4.3）
  const activeSessions: number = await db.playbackSession
    .count({ where: { mediaId, revokedAt: null, expiresAt: { gt: new Date() } } })
    .catch(() => 0);
  if (activeSessions > 0) {
    throw new KeyError(
      "bad_request",
      `该媒资有 ${activeSessions} 个未过期的播放会话，请先吊销会话再删除密钥`,
      409,
    );
  }

  try {
    await db.hlsKey.delete({ where: { mediaId } });
  } catch (e) {
    if ((e as { code?: string }).code === "P2025") {
      throw new KeyError("not_found", `该媒资没有密钥：${mediaId}`, 404);
    }
    throw new KeyError("internal", `删除密钥失败：${(e as Error).message}`, 500);
  }
  return { media_id: mediaId };
}

// ---- MK 状态与轮换（ADR-0006 §6：新增 mk_ver 后重封装全部 CEK，无需重转码） ----

export async function masterKeyStatus(): Promise<z.infer<typeof MasterKeyStatus>> {
  const mks = loadMasterKeys();
  const active = pickWrappingMasterKey(mks);
  const rows: Array<{ mkVer: number }> = await db.hlsKey.findMany({ select: { mkVer: true } });
  const counts = new Map<number, number>();
  for (const r of rows) counts.set(r.mkVer, (counts.get(r.mkVer) ?? 0) + 1);
  return {
    active_ver: active.ver,
    versions: mks
      .map((m) => ({ ver: m.ver, keys: counts.get(m.ver) ?? 0 }))
      .sort((a, b) => a.ver - b.ver),
    total_keys: rows.length,
  };
}

export async function rotateMasterKeys(
  body: unknown,
): Promise<z.infer<typeof RotateMasterKeysResponse>> {
  const parsed = RotateMasterKeysRequest.safeParse(body ?? {});
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path = issue?.path?.length ? `${issue.path.join(".")}: ` : "";
    throw new KeyError("bad_request", `${path}${issue?.message ?? "请求体校验失败"}`, 400);
  }
  const mks = loadMasterKeys();
  const active = pickWrappingMasterKey(mks);

  const rows: Array<{ id: string; mediaId: string; kid: string; wrappedCekHex: string; mkVer: number }> =
    await db.hlsKey.findMany({
      select: { id: true, mediaId: true, kid: true, wrappedCekHex: true, mkVer: true },
    });
  const targets = rows.filter(
    (r) => r.mkVer !== active.ver && (parsed.data.from_ver == null || r.mkVer === parsed.data.from_ver),
  );

  const errors: Array<{ media_id: string; kid: string; message: string }> = [];
  let rotated = 0;
  for (const row of targets) {
    try {
      // 明文 CEK 仅在此处短暂存在于内存（解封 → 立刻用 active MK 重新封装）
      const next = resealMediaKey(mks, { wrappedCekHex: row.wrappedCekHex, mkVer: row.mkVer });
      await db.hlsKey.update({
        where: { id: row.id },
        data: { wrappedCekHex: next.wrappedCekHex, mkVer: next.mkVer },
      });
      rotated += 1;
    } catch (e) {
      if (errors.length < 20) {
        errors.push({ media_id: row.mediaId, kid: row.kid, message: (e as Error).message });
      }
    }
  }

  return { rotated, failed: targets.length - rotated, to_ver: active.ver, errors };
}

/** 校验 MASTER_KEYS 中是否保留了指定版本（供页面提示：轮换前必须保留旧版本） */
export function hasMasterKeyVersion(ver: number): boolean {
  try {
    findMasterKey(loadMasterKeys(), ver);
    return true;
  } catch {
    return false;
  }
}

// ---- CEK 轮换（spec.md §4.4，2026-11-13；ADR-0006 §6：重转码该媒资全部加密模板产物） ----
// 编排逻辑在 ./keys-rotate（依赖注入纯函数）；此处只做真实依赖装配 + 错误类型转换。

export async function rotateMediaCek(mediaId: string, body: unknown): Promise<z.infer<typeof RotateCekResponse>> {
  const parsed = RotateCekRequest.safeParse(body ?? {});
  if (!parsed.success) {
    throw new KeyError("bad_request", "请求体校验失败", 400);
  }
  const dbAny = db as any;
  try {
    return await rotateMediaKeyWithDeps(mediaId, {
      assertMediaId,
      findKeyRow: (id) =>
        dbAny.hlsKey.findUnique({ where: { mediaId: id }, select: { kid: true } }).catch(() => null),
      listActiveJobs: (id) =>
        dbAny.transcodeJob.findMany({
          where: { mediaId: id, status: { in: ACTIVE_JOB_STATUSES } },
          select: { id: true, templateId: true, keyPlan: true },
        }),
      listProducts: async (id) => {
        const objects = await (await getStorage()).listObjects(`${STORAGE_PARTITIONS.proceed}/${id}/`);
        return groupProductsByMedia(objects).get(id) ?? [];
      },
      // 模板可能已删（孤儿产物）：返回 null 降级为 skipped，不整批失败
      findTemplate: async (templateId) =>
        dbAny.transcodeTemplate
          .findUnique({ where: { id: templateId } })
          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Prisma 动态行，与模板域同构
          .then((row: any) => (row ? templateRowToDto(row) : null))
          .catch(() => null),
      getWatermark,
      createJobs: (rows) =>
        dbAny.$transaction(rows.map((data: unknown) => dbAny.transcodeJob.create({ data }))),
      // 计划密钥只此一处生成：明文 CEK 在本闭包内出现后立即被丢弃（keyPlanFromMaterial 不带走明文），
      // 落库 / 返回值里只有 MK 封装形态（spec.md §4.1 明文红线）
      generateKeyPlan: () => keyPlanFromMaterial(createMediaKey(pickWrappingMasterKey(loadMasterKeys()))),
    });
  } catch (e) {
    if (e instanceof RotateCekError) throw new KeyError(e.code, e.message, e.status);
    throw e;
  }
}

/** 业务错误 → 统一错误信封响应 */
export function keyErrorResponse(e: unknown): NextResponse {
  if (e instanceof KeyError) return apiError(e.code, e.message, e.status);
  console.error("[keys] unexpected error:", e);
  return apiError("internal", (e as Error)?.message ?? "内部错误", 500);
}
