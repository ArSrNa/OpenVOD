// /api/admin/settings：系统设置（system_settings key-value）
//   GET  读取（含 env 回退值供 UI 提示）
//   PUT  更新（zod 之外的轻量校验在 lib/settings；空串 = 清除回退 env）
import { NextRequest, NextResponse } from "next/server";
import { apiJson, getAdminSession, unauthorized } from "@/lib/api";
import { getSettingsSnapshot, settingsErrorResponse } from "@/lib/settings";
import { checkSettingsOrigin, readSettingsEditor, saveSettingsEditor, settingsRequestBody } from "@/lib/settings-editor";
import { clientIp } from "@/lib/audit";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<NextResponse> {
  const session = await getAdminSession(req);
  if (!session) return unauthorized();
  try {
    const group = req.nextUrl.searchParams.get("group") ?? "playback";
    const result = await readSettingsEditor(group);
    return apiJson({ ...result,
      // 兼容原单字段 GET 调用方。
      ...(group === "playback" ? { playback_base_url: result.fields.find((f) => f.key === "playback_base_url")?.value ?? "", env_public_base_url: process.env.DELIVERY_PUBLIC_BASE_URL?.trim() ?? "" } : {}),
    });
  } catch (e) {
    return settingsErrorResponse(e);
  }
}

export async function PUT(req: NextRequest): Promise<NextResponse> {
  const session = await getAdminSession(req);
  if (!session) return unauthorized();
  try {
    const snapshot = await getSettingsSnapshot();
    const baseUrl = process.env.CNB_VSCODE_PROXY_URI
      ? process.env.CNB_VSCODE_PROXY_URI.replace(/\{\{port\}\}/gi, process.env.ADMIN_PORT ?? "8787")
      : snapshot.admin.baseUrl;
    checkSettingsOrigin(req, baseUrl);
    let body = await settingsRequestBody(req);
    const legacy = body && typeof body === "object" && !Array.isArray(body) && Object.keys(body).length === 1 && "playback_base_url" in body;
    if (legacy) {
      const current = await readSettingsEditor("playback");
      body = { group: "playback", revision: current.revision, values: body };
    }
    const result = await saveSettingsEditor(body, { id: session.user.id, ip: clientIp(req.headers) });
    return apiJson(legacy ? { playback_base_url: result.fields.find((f) => f.key === "playback_base_url")?.value ?? "" } : result);
  } catch (e) {
    return settingsErrorResponse(e);
  }
}
