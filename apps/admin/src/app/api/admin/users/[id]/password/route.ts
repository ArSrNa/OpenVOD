// /api/admin/users/[id]/password：重置播放端用户密码（ADR-0007）
// 管理员代重置（业务侧口令由 App 用户自行保管）；口令以 bcrypt cost 12 哈希后入库。
// 凭据变更后**同步吊销该用户未过期的播放会话**——否则旧凭据签发的 JWT 在 exp 前仍可播放，
// 与「封禁即吊销会话」（ADR-0007）取同一收敛口径；吊销条数随响应 revoked_sessions 返回。
import { NextRequest, NextResponse } from "next/server";
import { apiJson, auditAction, getAdminSession, unauthorized } from "@/lib/api";
import { defaultUserDeps, resetUserPassword, userErrorResponse } from "@/lib/users";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function POST(req: NextRequest, ctx: Ctx): Promise<NextResponse> {
  const session = await getAdminSession(req);
  if (!session) return unauthorized();
  try {
    const { id } = await ctx.params;
    const body = await req.json().catch(() => null);
    const result = await resetUserPassword(id, body, defaultUserDeps);
    await auditAction(req, session, "user.password_reset", id, {
      username: result.username,
      revoked_sessions: result.revoked_sessions,
    });
    return apiJson(result);
  } catch (e) {
    return userErrorResponse(e);
  }
}
