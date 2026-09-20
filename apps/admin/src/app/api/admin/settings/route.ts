// /api/admin/settings：系统设置（system_settings key-value）
//   GET  读取（含 env 回退值供 UI 提示）
//   PUT  更新（zod 之外的轻量校验在 lib/settings；空串 = 清除回退 env）
import { NextRequest, NextResponse } from "next/server";
import { apiJson, auditAction, getAdminSession, unauthorized } from "@/lib/api";
import { getSettings, settingsErrorResponse, updateSettings } from "@/lib/settings";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<NextResponse> {
  const session = await getAdminSession(req);
  if (!session) return unauthorized();
  try {
    return apiJson(await getSettings());
  } catch (e) {
    return settingsErrorResponse(e);
  }
}

export async function PUT(req: NextRequest): Promise<NextResponse> {
  const session = await getAdminSession(req);
  if (!session) return unauthorized();
  try {
    const body = await req.json().catch(() => null);
    const result = await updateSettings(body);
    await auditAction(req, session, "settings.update", null, result);
    return apiJson(result);
  } catch (e) {
    return settingsErrorResponse(e);
  }
}
