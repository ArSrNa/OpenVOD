// /api/admin/users：播放端用户列表 / 创建（ADR-0004 users 表；ADR-0007 账户域）
//   GET   列表（创建时间倒序）：用户名 / 展示名 / 状态 / 并发上限 / 未过期会话数 / 最近登录时间
//         —— 响应不含 password_hash（管理端无查看口令哈希的入口）
//   POST  创建：username + password（bcrypt cost 12）→ 默认 ACTIVE；用户名冲突 409
import { NextRequest, NextResponse } from "next/server";
import { apiJson, auditAction, getAdminSession, unauthorized } from "@/lib/api";
import { createUser, defaultUserDeps, listUsers, userErrorResponse } from "@/lib/users";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<NextResponse> {
  const session = await getAdminSession(req);
  if (!session) return unauthorized();
  try {
    return apiJson(await listUsers(defaultUserDeps));
  } catch (e) {
    return userErrorResponse(e);
  }
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const session = await getAdminSession(req);
  if (!session) return unauthorized();
  try {
    const body = await req.json().catch(() => null);
    const user = await createUser(body, defaultUserDeps);
    await auditAction(req, session, "user.create", user.id, {
      username: user.username,
      status: user.status,
      max_concurrent_sessions: user.max_concurrent_sessions,
    });
    return apiJson({ item: user }, 201);
  } catch (e) {
    return userErrorResponse(e);
  }
}
