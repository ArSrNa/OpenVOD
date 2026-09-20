// /api/admin/templates/[id]：转码模板详情 / 更新 / 删除（ADR-0014）
//   GET    详情
//   PATCH  部分字段更新（keep_original 翻转时对 params 的约束见 lib/templates.ts）
//   DELETE 删除（任务引用为 submit 时快照，无外键，可直接删）
import { NextRequest, NextResponse } from "next/server";
import { apiJson, auditAction, getAdminSession, unauthorized } from "@/lib/api";
import { deleteTemplate, getTemplate, templateErrorResponse, updateTemplate } from "@/lib/templates";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: NextRequest, ctx: Ctx): Promise<NextResponse> {
  const session = await getAdminSession(req);
  if (!session) return unauthorized();
  try {
    const { id } = await ctx.params;
    return apiJson({ item: await getTemplate(id) });
  } catch (e) {
    return templateErrorResponse(e);
  }
}

export async function PATCH(req: NextRequest, ctx: Ctx): Promise<NextResponse> {
  const session = await getAdminSession(req);
  if (!session) return unauthorized();
  try {
    const { id } = await ctx.params;
    const body = await req.json().catch(() => null);
    const item = await updateTemplate(id, body);
    await auditAction(req, session, "template.update", id, { name: item.name });
    return apiJson({ item });
  } catch (e) {
    return templateErrorResponse(e);
  }
}

export async function DELETE(req: NextRequest, ctx: Ctx): Promise<NextResponse> {
  const session = await getAdminSession(req);
  if (!session) return unauthorized();
  try {
    const { id } = await ctx.params;
    const result = await deleteTemplate(id);
    await auditAction(req, session, "template.delete", id);
    return apiJson(result);
  } catch (e) {
    return templateErrorResponse(e);
  }
}
