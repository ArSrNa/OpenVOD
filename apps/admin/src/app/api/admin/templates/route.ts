// /api/admin/templates：转码模板 CRUD（ADR-0014；intent.md「转码模板管理」）
//   GET   列表（创建时间倒序）
//   POST  创建（zod 校验：contracts 唯一真相源；加密必须 HLS；keep_original 时 params 落 NULL）
import { NextRequest, NextResponse } from "next/server";
import { apiJson, auditAction, getAdminSession, unauthorized } from "@/lib/api";
import { createTemplate, listTemplates, templateErrorResponse } from "@/lib/templates";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<NextResponse> {
  const session = await getAdminSession(req);
  if (!session) return unauthorized();
  try {
    return apiJson(await listTemplates());
  } catch (e) {
    return templateErrorResponse(e);
  }
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const session = await getAdminSession(req);
  if (!session) return unauthorized();
  try {
    const body = await req.json().catch(() => null);
    const item = await createTemplate(body);
    await auditAction(req, session, "template.create", item.id, { name: item.name });
    return apiJson({ item }, 201);
  } catch (e) {
    return templateErrorResponse(e);
  }
}
