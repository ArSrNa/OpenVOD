// /api/admin/media/{id}/product-settings：媒资级转码产物展示与默认（spec.md §6.3/§11.1，2026-11-15）
//   PATCH 保存 {visible_template_ids, default_template_id}（字段缺省 = 不修改）：
//         只改变分发端 play 的 templates[] 与未指定 template_id 时的自动选择，
//         **不删除存储对象、不改变产物可访问性**（显式 template_id 仍可播放）。
//   详情读取见 GET /api/admin/media/{id}（products[].isVisible / isDefault + productSettings）。
import { NextRequest, NextResponse } from "next/server";
import { UpdateMediaProductSettingsRequest, z } from "@openvod/contracts";
import { apiError, apiJson, auditAction, getAdminSession, unauthorized } from "@/lib/api";
import { mediaErrorResponse, updateMediaProductSettings } from "@/lib/media";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** zod 校验失败 → 400（取首条 issue，带字段路径） */
function firstIssue(error: z.ZodError): string {
  const issue = error.issues[0];
  const path = issue?.path?.length ? `${issue.path.join(".")}: ` : "";
  return `${path}${issue?.message ?? "请求体校验失败"}`;
}

export async function PATCH(req: NextRequest, ctx: Ctx): Promise<NextResponse> {
  const session = await getAdminSession(req);
  if (!session) return unauthorized();
  try {
    const { id } = await ctx.params;
    const parsed = UpdateMediaProductSettingsRequest.safeParse(
      await req.json().catch(() => null),
    );
    if (!parsed.success) return apiError("bad_request", firstIssue(parsed.error), 400);

    const settings = await updateMediaProductSettings(id, parsed.data);
    await auditAction(req, session, "media.product_settings_update", id, {
      visible_template_ids: settings.visible_template_ids,
      default_template_id: settings.default_template_id,
    });
    return apiJson({ productSettings: settings });
  } catch (e) {
    return mediaErrorResponse(e);
  }
}
