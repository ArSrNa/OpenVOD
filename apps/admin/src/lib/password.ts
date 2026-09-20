// 播放端用户口令哈希（ADR-0007：bcrypt，cost ≥12）
// 跨语言互通：管理端（本模块，bcryptjs）建号 → 分发端（Go golang.org/x/crypto/bcrypt）验登录，
// 哈希串为 `$2a$` 前缀的标准 bcrypt，两端实现互通（bootstrap-playback.ts 与用户管理共用）。
// 为什么不用 Bun.password：管理端跑在 Node 运行时（next start，ADR-0013），Bun API 不可用；
// bcryptjs 为纯 JS 实现（零原生编译、零依赖），在容器 / SCF / 本地开发下行为一致。
import bcrypt from "bcryptjs";
import { USER_PASSWORD_MAX_LENGTH } from "@openvod/contracts";

/** ADR-0007 规定 cost ≥12；与 bootstrap-playback.ts 历史值保持一致 */
export const PASSWORD_BCRYPT_COST = 12;

/** bcrypt 只取前 72 字节，超出部分被静默丢弃（含多字节字符的截断还可能与校验端不一致），契约层就拦掉 */
export const PASSWORD_MAX_LENGTH = USER_PASSWORD_MAX_LENGTH;

/** 哈希明文口令（返回标准 bcrypt 哈希串，形如 $2a$12$…） */
export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, PASSWORD_BCRYPT_COST);
}

/** 校验明文口令与哈希是否匹配（供管理端自检 / 与分发端口径一致） */
export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  try {
    return await bcrypt.compare(password, hash);
  } catch {
    return false; // 非法哈希串（如手工改坏的历史数据）按不匹配处理
  }
}
