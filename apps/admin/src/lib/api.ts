// 控制台 API 公共设施（spec.md §2）：better-auth 会话守卫、统一错误信封、审计。
// 管理端 /api/admin/* 复用 better-auth Cookie 会话，未登录一律 401。
// 信封本体在 ./envelope（无 DB / auth 依赖，业务 lib 直接引它，避免 import 图把 Prisma 单例拖起来）。
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { clientIp, recordAudit } from "./audit";

export { apiError, apiJson, unauthorized } from "./envelope";

export type AdminSession = NonNullable<Awaited<ReturnType<typeof auth.api.getSession>>>;

/** 会话守卫：返回 session 或 null（调用方统一 unauthorized()） */
export async function getAdminSession(req: NextRequest): Promise<AdminSession | null> {
  return auth.api.getSession({ headers: req.headers });
}

/** 管理端敏感操作审计（open-questions #14：媒资状态变更等） */
export async function auditAction(
  req: NextRequest,
  session: AdminSession,
  action: string,
  target: string | null,
  detail?: Record<string, unknown>,
): Promise<void> {
  await recordAudit({
    actorType: "admin_user",
    actorId: session.user.id,
    action,
    target,
    detail,
    ip: clientIp(req.headers),
  });
}
