// 每媒资密钥材料：CEK / IV / kid 生成、MK 封装与轮换重封装（ADR-0006 §1/§2 + spec.md §4）。
//
// 纯函数模块：不访问数据库、不做持久化、不写日志。明文 CEK 只允许存在于调用栈——
// 持久化（`hls_keys` 的 wrapped_cek）与响应（分发端密钥接口）由调用方负责，见 spec.md §4.1。
import { randomBytes } from "node:crypto";
import { genCek, genMediaIV, type MasterKey, unwrap, wrap } from "./wrap";

/** 每媒资密钥材料；`cek` 为明文（绝不落库 / 出网 / 记日志） */
export interface MediaKeyMaterial {
  kid: string;
  method: "AES-128";
  /** 明文 CEK（16B）——仅用于写 ffmpeg key_info 与密钥接口响应 */
  cek: Buffer;
  /** 显式 IV（hex，无 0x 前缀；写入清单 EXT-X-KEY 与 key_info 第三行） */
  ivHex: string;
  /** MK(AES-256-GCM) 封装后的 CEK（hex）——这是唯一允许入库的形态 */
  wrappedCekHex: string;
  /** 封装所用 MK 版本 */
  mkVer: number;
}

/** 随机 kid：16 字节 hex（128 位随机；`hls_keys.kid` 有唯一约束，碰撞概率可忽略） */
export function genKid(): string {
  return randomBytes(16).toString("hex");
}

/** 取「新封装」使用的 MK：版本号最大者（轮换时新增 mk_ver 后新媒资自然用新版本，ADR-0006 §6） */
export function pickWrappingMasterKey(mks: MasterKey[]): MasterKey {
  if (!mks.length) throw new Error("MASTER_KEYS 为空，无法封装 CEK（见 .env.example）");
  return mks.reduce((a, b) => (b.ver > a.ver ? b : a));
}

/** 按版本号取 MK；缺失即抛错（说明部署侧 MASTER_KEYS 未保留历史版本，无法解封） */
export function findMasterKey(mks: MasterKey[], ver: number): MasterKey {
  const mk = mks.find((m) => m.ver === ver);
  if (!mk) throw new Error(`MASTER_KEYS 中不存在版本 ${ver}，无法解封该密钥（轮换需保留旧版本）`);
  return mk;
}

/**
 * 生成一个媒资的密钥材料：CEK(16B) + 显式 IV(16B) + kid，并以给定 MK 封装。
 * 「每媒资一份」由调用方在事务内整行替换 `hls_keys` 保证（spec.md §4.1/§4.2）。
 */
export function createMediaKey(mk: MasterKey): MediaKeyMaterial {
  const cek = genCek();
  const iv = genMediaIV();
  return {
    kid: genKid(),
    method: "AES-128",
    cek,
    ivHex: iv.toString("hex"),
    wrappedCekHex: wrap(mk.key, cek).toString("hex"),
    mkVer: mk.ver,
  };
}

/** 解封 CEK（重封装轮换 / 播放密钥接口用）；封装串损坏或 MK 不符时抛错（GCM 自带认证） */
export function openMediaKey(mk: MasterKey, wrappedCekHex: string): Buffer {
  return unwrap(mk.key, Buffer.from(wrappedCekHex, "hex"));
}

/**
 * 轮换重封装：用行记录自身的 mk_ver 解封，再用 active MK（最大版本）重新封装。
 * 已是 active 版本时原样返回（幂等，便于全表扫描重复调用）。
 */
export function resealMediaKey(
  mks: MasterKey[],
  input: { wrappedCekHex: string; mkVer: number },
): { wrappedCekHex: string; mkVer: number } {
  const active = pickWrappingMasterKey(mks);
  if (input.mkVer === active.ver) return input;
  const cek = openMediaKey(findMasterKey(mks, input.mkVer), input.wrappedCekHex);
  return { wrappedCekHex: wrap(active.key, cek).toString("hex"), mkVer: active.ver };
}
