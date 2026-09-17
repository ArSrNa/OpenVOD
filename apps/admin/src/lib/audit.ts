// 登录事件审计（ADR-0012 §3：登录事件写 audit_logs；范围 open-questions #14）
import { getDb } from "@openvod/db";

const db = getDb<any>();

export interface LoginAuditEntry {
  actorType: "admin_user" | "anonymous";
  actorId: string;
  action: "console.login" | "console.login_failed";
  target: string | null;
  detail: Record<string, unknown>;
  ip: string | null;
}

/** 写登录审计；审计失败只记日志，不阻断登录链路 */
export async function recordLoginAudit(entry: LoginAuditEntry): Promise<void> {
  try {
    await db.auditLog.create({
      data: {
        actorType: entry.actorType,
        actorId: entry.actorId,
        action: entry.action,
        target: entry.target,
        detail: entry.detail,
        ip: entry.ip,
      },
    });
  } catch (e) {
    console.error("[audit] 登录审计写入失败:", (e as Error).message);
  }
}

/** 取真实客户端 IP（信任反代注入的 x-forwarded-for 首段） */
export function clientIp(headers: Headers | null | undefined): string | null {
  const xff = headers?.get("x-forwarded-for");
  if (xff) return xff.split(",")[0].trim();
  return headers?.get("x-real-ip") ?? null;
}
