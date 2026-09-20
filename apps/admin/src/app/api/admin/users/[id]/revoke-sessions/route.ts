// /api/admin/users/[id]/revoke-sessions：吊销该用户全部未过期播放会话（ADR-0006/0007）
// 语义：会话 revoked_at 置当前时间，分发端对吊销会话的新清单 / 密钥请求立即拒绝（≤60s 缓存收敛）；
// 已下发的分片 token 在自身 exp 内仍有效（ADR-0006 已声明接受）。用户本人不受影响，可重新登录。
import { NextRequest, NextResponse } from "next/server";
import { apiJson, auditAction, getAdminSession, unauthorized } from "@/lib/api";
import { defaultUserDeps, revokeUserSessions, userErrorResponse } from "@/lib/users";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function POST(req: NextRequest, ctx: Ctx): Promise<NextResponse> {
  const session = await getAdminSession(req);
  if (!session) return unauthorized();
  try {
    const { id } = await ctx.params;
    const result = await revokeUserSessions(id, defaultUserDeps);
    await auditAction(req, session, "user.revoke_sessions", id, {
      username: result.username,
      revoked_sessions: result.revoked_sessions,
    });
    return apiJson(result);
  } catch (e) {
    return userErrorResponse(e);
  }
}
