// /api/admin/media/[id]/subtitles/[trackId]：轨道元信息更新 / 删除（spec.md §7.4）
//   PATCH   label / lang / is_default（JSON；lang 走同一归一化与唯一校验，is_default=true 事务内互斥）
//   DELETE  删除轨道：先删对象、再删 DB 行（幂等可重试，spec.md §7.2）；不自动改派默认轨
// trackId 形状不符（非 cuid 形状）→ 404（路由层白名单，兼作路径注入防护）。
import { NextRequest, NextResponse } from "next/server";
import { apiJson, auditAction, getAdminSession, unauthorized } from "@/lib/api";
import { defaultSubtitleDeps, deleteSubtitle, subtitleErrorResponse, updateSubtitle } from "@/lib/subtitles";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string; trackId: string }> };

export async function PATCH(req: NextRequest, ctx: Ctx): Promise<NextResponse> {
  const session = await getAdminSession(req);
  if (!session) return unauthorized();
  try {
    const { id, trackId } = await ctx.params;
    const body = await req.json().catch(() => null);
    const item = await updateSubtitle(id, trackId, body, defaultSubtitleDeps);
    await auditAction(req, session, "subtitle.update", id, {
      track_id: item.id,
      lang: item.lang,
      label: item.label,
      is_default: item.is_default,
    });
    return apiJson({ item });
  } catch (e) {
    return subtitleErrorResponse(e);
  }
}

export async function DELETE(req: NextRequest, ctx: Ctx): Promise<NextResponse> {
  const session = await getAdminSession(req);
  if (!session) return unauthorized();
  try {
    const { id, trackId } = await ctx.params;
    const removed = await deleteSubtitle(id, trackId, defaultSubtitleDeps);
    await auditAction(req, session, "subtitle.delete", id, {
      track_id: removed.id,
      lang: removed.lang,
      label: removed.label,
    });
    return apiJson({ removed: true, item: removed });
  } catch (e) {
    return subtitleErrorResponse(e);
  }
}
