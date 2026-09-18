// 每媒资密钥的生成与落库（spec.md §4.2；ADR-0006 §2）
//
// 顺序即安全边界：**先生成（不落库）→ 转码加密 → 产物上传成功后才落库**。
// 若提前落库，一次失败的转码就会把该媒资原有密钥换掉，使既有加密产物无法解密（spec.md §4.2）。
import {
  createMediaKey,
  findMasterKey,
  openMediaKey,
  parseMasterKeys,
  pickWrappingMasterKey,
  type MasterKey,
} from "@openvod/crypto";
import type { MediaKeyRecord, MediaKeyStore } from "./media-key-store";

/** 密钥落地相关错误（消息面向运维，直接进日志 / 任务 lastError） */
export class MediaKeyError extends Error {}

/**
 * 解析 MASTER_KEYS（`"版本:64位hex"` 逗号分隔，ADR-0006 §1）。
 * 加密任务的前提条件；Worker 启动自检与任务执行共用同一入口。
 */
export function loadMasterKeys(env: string | undefined = process.env.MASTER_KEYS): MasterKey[] {
  try {
    return parseMasterKeys(env);
  } catch (e) {
    throw new MediaKeyError(`MASTER_KEYS 不可用：${(e as Error).message}`);
  }
}

/** 当前用于「新封装」的 MK 版本描述（日志 / 自检用，不含密钥材料） */
export function describeMasterKeys(mks: MasterKey[]): string {
  const active = pickWrappingMasterKey(mks);
  return `${mks.map((m) => `v${m.ver}`).join(" / ")}（封装用 v${active.ver}）`;
}

/** 生成中的密钥材料：既有落库形态，也有写 key_info 用的明文 CEK */
export interface GeneratedMediaKey extends MediaKeyRecord {
  /** 明文 CEK（16B）：只允许写入任务临时 key 文件，随任务目录一起清理 */
  cek: Buffer;
}

/**
 * 生成该媒资的密钥材料（**不落库**，spec.md §4.2 步骤 1）：
 * CEK(16B) + 显式 IV(16B) + kid，并以 active MK（`MASTER_KEYS` 最大版本）封装。
 */
export function generateMediaKey(mks: MasterKey[]): GeneratedMediaKey {
  const active = pickWrappingMasterKey(mks);
  const material = createMediaKey(active);
  return {
    kid: material.kid,
    method: material.method,
    ivHex: material.ivHex,
    wrappedCekHex: material.wrappedCekHex,
    mkVer: material.mkVer,
    cek: material.cek,
  };
}

/**
 * 落库（**产物上传成功后**才能调用，spec.md §4.2 步骤 3）：
 * 每媒资一份 —— 事务内整行替换，旧 kid 立即失效。
 */
export async function persistMediaKey(
  store: MediaKeyStore,
  mediaId: string,
  key: GeneratedMediaKey,
): Promise<{ replaced: boolean }> {
  return store.replace(mediaId, {
    kid: key.kid,
    method: key.method,
    ivHex: key.ivHex,
    wrappedCekHex: key.wrappedCekHex,
    mkVer: key.mkVer,
  });
}

/** 本次转码实际使用的密钥 + 是否为复用 */
export interface ResolvedMediaKey extends GeneratedMediaKey {
  /** true = 沿用该媒资已有密钥（未落库，也无需落库） */
  reused: boolean;
}

/**
 * 取该媒资本次转码要用的密钥（spec.md §1.3 / §4.2）：
 *
 * - **已有密钥行 → 解封复用**：同一媒资的多个模板产物（`proceed/{id}/{templateId}/`）共用同一份
 *   CEK。否则「用模板 B 转码」会换掉该媒资的密钥行，让模板 A 的既有密文变得无法解密；
 * - **没有 → 新生成**，且由调用方在**产物上传成功后**落库（persistMediaKey）。
 */
export async function resolveMediaKey(
  store: MediaKeyStore,
  mks: MasterKey[],
  mediaId: string,
): Promise<ResolvedMediaKey> {
  const existing = await store.find(mediaId);
  if (!existing) {
    return { ...generateMediaKey(mks), reused: false };
  }
  return {
    kid: existing.kid,
    method: existing.method,
    ivHex: existing.ivHex,
    wrappedCekHex: existing.wrappedCekHex,
    mkVer: existing.mkVer,
    // 明文只在本次任务的临时目录里出现，随任务目录一起清理
    cek: openMediaKey(findMasterKey(mks, existing.mkVer), existing.wrappedCekHex),
    reused: true,
  };
}
