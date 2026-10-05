// GET /api/admin/watermarks/[id]：水印模板详情（spec.md §10.3）
// PATCH：更新名称 / 描述 / 参数（type 不可改，params.type 必须与既有模板一致，spec.md §10.1）
// DELETE：删除模板（先删 watermark/ 对象、再删行；被转码模板引用时 409 —— 转码关联落地后生效）
import { NextRequest, NextResponse } from "next/server";
import { apiJson, auditAction, getAdminSession, unauthorized } from "@/lib/api";
import { deleteWatermark, getWatermark, updateWatermark, watermarkErrorResponse } from "@/lib/watermarks";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: NextRequest, ctx: Ctx): Promise<NextResponse> {
  const session = await getAdminSession(req);
  if (!session) return unauthorized();
  try {
    const { id } = await ctx.params;
    return apiJson({ item: await getWatermark(id) });
  } catch (e) {
    return watermarkErrorResponse(e);
  }
}

export async function PATCH(req: NextRequest, ctx: Ctx): Promise<NextResponse> {
  const session = await getAdminSession(req);
  if (!session) return unauthorized();
  try {
    const { id } = await ctx.params;
    const body = await req.json().catch(() => null);
    const item = await updateWatermark(id, body);
    await auditAction(req, session, "watermark.update", id, { name: item.name });
    return apiJson({ item });
  } catch (e) {
    return watermarkErrorResponse(e);
  }
}

export async function DELETE(req: NextRequest, ctx: Ctx): Promise<NextResponse> {
  const session = await getAdminSession(req);
  if (!session) return unauthorized();
  try {
    const { id } = await ctx.params;
    const result = await deleteWatermark(id);
    await auditAction(req, session, "watermark.delete", id, {
      removed_objects: result.removed_objects,
    });
    return apiJson(result);
  } catch (e) {
    return watermarkErrorResponse(e);
  }
}
