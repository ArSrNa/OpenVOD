// /api/admin/users/[id]：播放端用户详情 / 更新 / 删除（ADR-0004 users 表；ADR-0007 账户域）
//   GET    详情：DTO + 未过期会话数
//   PATCH  更新展示名 / 状态 / 并发上限；**封禁（ACTIVE→DISABLED）时立即吊销该用户全部未过期会话**
//          （ADR-0007：封禁 → 登录拒绝 + 全会话吊销），吊销条数随响应 revoked_sessions 返回
//   DELETE 删除用户：playback_sessions 随用户级联删除（Prisma onDelete: Cascade）
import { NextRequest, NextResponse } from "next/server";
import { apiJson, auditAction, getAdminSession, unauthorized } from "@/lib/api";
import { defaultUserDeps, deleteUser, getUser, updateUser, userErrorResponse } from "@/lib/users";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: NextRequest, ctx: Ctx): Promise<NextResponse> {
  const session = await getAdminSession(req);
  if (!session) return unauthorized();
  try {
    const { id } = await ctx.params;
    return apiJson({ item: await getUser(id, defaultUserDeps) });
  } catch (e) {
    return userErrorResponse(e);
  }
}

export async function PATCH(req: NextRequest, ctx: Ctx): Promise<NextResponse> {
  const session = await getAdminSession(req);
  if (!session) return unauthorized();
  try {
    const { id } = await ctx.params;
    const body = await req.json().catch(() => null);
    const result = await updateUser(id, body, defaultUserDeps);
    await auditAction(req, session, "user.update", id, {
      username: result.user.username,
      status: result.user.status,
      display_name: result.user.display_name,
      max_concurrent_sessions: result.user.max_concurrent_sessions,
      revoked_sessions: result.revoked_sessions,
    });
    return apiJson({ item: result.user, revoked_sessions: result.revoked_sessions });
  } catch (e) {
    return userErrorResponse(e);
  }
}

export async function DELETE(req: NextRequest, ctx: Ctx): Promise<NextResponse> {
  const session = await getAdminSession(req);
  if (!session) return unauthorized();
  try {
    const { id } = await ctx.params;
    const result = await deleteUser(id, defaultUserDeps);
    await auditAction(req, session, "user.delete", id, {
      username: result.username,
      revoked_sessions: result.revoked_sessions,
    });
    return apiJson(result);
  } catch (e) {
    return userErrorResponse(e);
  }
}
