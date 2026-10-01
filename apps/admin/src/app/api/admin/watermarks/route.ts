// GET /api/admin/watermarks：水印模板列表（创建时间倒序，spec.md §10.3）
// POST /api/admin/watermarks：新建水印模板（JSON；type 由 params.type 判别，spec.md §10.1）
// 图片资产走 /watermarks/[id]/image（两步创建，spec.md §10.2）。
import { NextRequest, NextResponse } from "next/server";
import { apiJson, auditAction, getAdminSession, unauthorized } from "@/lib/api";
import { createWatermark, listWatermarks, watermarkErrorResponse } from "@/lib/watermarks";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<NextResponse> {
  const session = await getAdminSession(req);
  if (!session) return unauthorized();
  try {
    return apiJson(await listWatermarks());
  } catch (e) {
    return watermarkErrorResponse(e);
  }
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const session = await getAdminSession(req);
  if (!session) return unauthorized();
  try {
    const body = await req.json().catch(() => null);
    const item = await createWatermark(body);
    await auditAction(req, session, "watermark.create", item.id, {
      name: item.name,
      type: item.type,
    });
    return apiJson({ item }, 201);
  } catch (e) {
    return watermarkErrorResponse(e);
  }
}
