// 控制台 API 公共设施（spec.md §2）：better-auth 会话守卫、统一错误信封、审计。
// 管理端 /api/admin/* 复用 better-auth Cookie 会话，未登录一律 401。
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { clientIp, recordAudit } from "./audit";

export type AdminSession = NonNullable<Awaited<ReturnType<typeof auth.api.getSession>>>;

/** 会话守卫：返回 session 或 null（调用方统一 unauthorized()） */
export async function getAdminSession(req: NextRequest): Promise<AdminSession | null> {
  return auth.api.getSession({ headers: req.headers });
}

/** 统一错误信封 { error: { code, message } }（错误码沿用 @openvod/shared ERROR_CODES） */
export function apiError(code: string, message: string, status: number): NextResponse {
  return NextResponse.json({ error: { code, message } }, { status, headers: { "Cache-Control": "no-store" } });
}

export function unauthorized(): NextResponse {
  return apiError("unauthorized", "未登录", 401);
}

/** 成功 JSON（管理端 API 一律 no-store） */
export function apiJson(data: unknown, status = 200): NextResponse {
  return NextResponse.json(data, { status, headers: { "Cache-Control": "no-store" } });
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
