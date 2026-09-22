// MASTER_KEYS 自检（ADR-0006 分层根 / ADR-0015：MK 永远只存在于 env）。
//
// 为什么单独一个文件：本模块**不依赖 DB / Prisma**，因此既能在 /api/setup 自检里用，
// 也能在进程启动自检（src/instrumentation.ts）里用——启动那一刻还没有任何 DB 访问。
//
// 为什么需要「原因」：旧实现 hasMasterKeys() 把「env 里没有」与「值格式非法」都吞成同一句
// “未配置”，部署侧明明配了却仍看到该提示时无从下手。这里把 parseMasterKeys 的报错原文
// 带出来（不含任何密钥值），区分「缺失 / 非法」，并附最常见误配的提示。
import { parseMasterKeys } from "@openvod/crypto";

export interface MasterKeysDiagnostic {
  /** env 中是否存在可用的 MK（缺失或格式非法均为 false） */
  ok: boolean;
  /** 失败原因（人类可读；**绝不包含密钥值**） */
  error: string | null;
  /** 已配置的 MK 版本号（升序去重；ok=false 时为空） */
  versions: number[];
  /** 值形态的可疑点提示（引号 / 空白 / 全角冒号 / hex 位数），无则为 null */
  hint: string | null;
}

/** 解析 "版本:64位hex[,版本:64位hex...]"；返回空数组表示未配置 */
function tryParse(env: string | undefined) {
  return parseMasterKeys(env);
}

/**
 * 值形态体检：只报「像不像粘贴事故」，不改判定。
 * 覆盖实测最常见的四类：平台配置框带引号、末尾/中间混入空白或换行、全角冒号、hex 不足 64 位。
 */
function shapeHint(env: string | undefined): string | null {
  if (env == null || env === "") return null;
  const raw = env;
  if (/^\s*["']|["']\s*$/.test(raw)) return "值被引号包裹（平台配置项里不需要写引号，请去掉）";
  if (/\s/.test(raw.trim())) return "值中间含空白/换行（粘贴时带入），必须删除";
  if (raw.includes("：")) return "含全角冒号「：」，分隔符必须是半角「:」";
  for (const part of raw.split(",")) {
    const seg = part.trim();
    const idx = seg.indexOf(":");
    if (idx < 0) continue;
    const hex = seg.slice(idx + 1);
    if (hex && !/^[0-9a-fA-F]+$/.test(hex)) return "hex 段含非 0-9a-f 字符（是否误用了 base64 / 口令？）";
    if (hex && hex.length !== 64) return `hex 段长度为 ${hex.length}，应为 64（openssl rand -hex 32）`;
  }
  return null;
}

/** MK 自检：成功给出已配置版本，失败给出原因与形态提示 */
export function masterKeysDiagnostic(
  env: string | undefined = process.env.MASTER_KEYS,
): MasterKeysDiagnostic {
  const hint = shapeHint(env);
  try {
    const mks = tryParse(env);
    return {
      ok: true,
      error: null,
      versions: [...new Set(mks.map((m) => m.ver))].sort((a, b) => a - b),
      hint,
    };
  } catch (e) {
    return { ok: false, error: (e as Error).message, versions: [], hint };
  }
}

/** 一行摘要（启动自检 / 日志用；不含密钥值） */
export function masterKeysSummary(d: MasterKeysDiagnostic = masterKeysDiagnostic()): string {
  if (d.ok) return `MASTER_KEYS 自检通过（版本 ${d.versions.map((v) => `v${v}`).join(" / ")}）`;
  const parts = [`MASTER_KEYS 自检失败：${d.error ?? "未知原因"}`];
  if (d.hint) parts.push(`提示：${d.hint}`);
  return parts.join("；");
}
