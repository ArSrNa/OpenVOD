// /api/admin/keys/{mediaId}：单媒资密钥详情 / 删除（spec.md §4.3）
//   GET    详情（kid / method / iv / mk_ver / 生成时间 / 使用中会话数）
//   DELETE 删除密钥行（危险：加密分片将无法解密；存在未过期会话时 409 拒绝）
import { NextRequest, NextResponse } from "next/server";
import { apiJson, auditAction, getAdminSession, unauthorized } from "@/lib/api";
import { deleteMediaKey, getMediaKey, keyErrorResponse } from "@/lib/keys";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ mediaId: string }> };

export async function GET(req: NextRequest, ctx: Ctx): Promise<NextResponse> {
  const session = await getAdminSession(req);
  if (!session) return unauthorized();
  try {
    const { mediaId } = await ctx.params;
    return apiJson({ item: await getMediaKey(mediaId) });
  } catch (e) {
    return keyErrorResponse(e);
  }
}

export async function DELETE(req: NextRequest, ctx: Ctx): Promise<NextResponse> {
  const session = await getAdminSession(req);
  if (!session) return unauthorized();
  try {
    const { mediaId } = await ctx.params;
    const result = await deleteMediaKey(mediaId);
    await auditAction(req, session, "key.delete", mediaId);
    return apiJson(result);
  } catch (e) {
    return keyErrorResponse(e);
  }
}
