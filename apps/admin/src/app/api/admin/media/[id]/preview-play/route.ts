// /api/admin/media/{id}/preview-play：产物解密播放预览（spec.md §6）
// 服务端以预览账号向分发端建会话 / 取签名主清单 URL，交浏览器按标准 HLS 播放；
// 清单、密钥（16B CEK）、分片全部由分发端 / 对象存储直达浏览器——管理端不出密钥（P0，spec.md §4.3）。
import { NextRequest, NextResponse } from "next/server";
import { apiError, apiJson, getAdminSession, unauthorized } from "@/lib/api";
import { DeliveryPreviewError, previewPlay } from "@/lib/delivery-preview";
import { MediaError, assertMediaId } from "@/lib/media";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function POST(req: NextRequest, ctx: Ctx): Promise<NextResponse> {
  const session = await getAdminSession(req);
  if (!session) return unauthorized();
  try {
    const { id } = await ctx.params;
    assertMediaId(id);
    const body = (await req.json().catch(() => null)) as { template_id?: unknown } | null;
    // 空串 = 显式请求旧布局产物（无模板段）；缺省 / null = 由分发端自动选择
    const templateId = typeof body?.template_id === "string" ? body.template_id : null;
    // 带浏览器 Origin 做一次对象桶 CORS 探测（只诊断；未配置时前端可立即提示「转圈」根因）
    return apiJson(await previewPlay(id, templateId, req.headers.get("origin")));
  } catch (e) {
    if (e instanceof MediaError) return apiError(e.code, e.message, e.status);
    if (e instanceof DeliveryPreviewError) return apiError(e.code, e.message, e.status);
    console.error("[preview-play] unexpected error:", e);
    return apiError("internal", (e as Error)?.message ?? "内部错误", 500);
  }
}
