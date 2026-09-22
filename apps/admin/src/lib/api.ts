// 控制台 API 公共设施（spec.md §2）：better-auth 会话守卫、统一错误信封、审计。
// 管理端 /api/admin/* 复用 better-auth Cookie 会话，未登录一律 401。
// 信封本体在 ./envelope（无 DB / auth 依赖，业务 lib 直接引它，避免 import 图把 Prisma 单例拖起来）。
import { NextRequest, NextResponse } from "next/server";
import { getAuth, type AuthInstance } from "@/lib/auth";
import { isSetupCompleted } from "@/lib/settings";
import { clientIp, recordAudit } from "./audit";

export { apiError, apiJson, unauthorized } from "./envelope";

export type AdminSession = NonNullable<Awaited<ReturnType<AuthInstance["api"]["getSession"]>>>;

/**
 * 会话守卫：返回 session 或 null（调用方统一 unauthorized()）。
 * ADR-0015：未完成首次启动向导（system_settings.setup_completed 缺失）时一并拒绝，
 * 业务 API 在向导完成前不可用（/api/setup 除外，它不经过本守卫）。
 */
export async function getAdminSession(req: NextRequest): Promise<AdminSession | null> {
  const auth = await getAuth();
  const session = await auth.api.getSession({ headers: req.headers });
  if (!session) return null;
  try {
    if (!(await isSetupCompleted())) return null;
  } catch {
    // 设置读取失败（DB 抖动）不放大为拒绝——沿用会话结果
  }
  return session;
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
