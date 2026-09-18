// /api/admin/media/{id}/products/{templateId}：删除一套转码产物（spec.md §1.3/§5.5）
//   templateId = 模板 cuid（删该模板子树 proceed/{id}/{templateId}/）
//   templateId = "legacy"（旧布局：删 proceed/{id}/ 顶层非保留段对象）
// 只删存储对象；hls_keys 与 transcode_jobs 历史保留（密钥可能被其它模板产物共用）；
// 存在未终结的同模板任务时 409 拒绝（Worker 上传与删除互斥）；操作落 audit_logs。
import { NextRequest, NextResponse } from "next/server";
import { apiJson, auditAction, getAdminSession, unauthorized } from "@/lib/api";
import { deleteMediaProduct, mediaErrorResponse } from "@/lib/media";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string; templateId: string }> };

export async function DELETE(req: NextRequest, ctx: Ctx): Promise<NextResponse> {
  const session = await getAdminSession(req);
  if (!session) return unauthorized();
  try {
    const { id, templateId } = await ctx.params;
    const result = await deleteMediaProduct(id, templateId);
    await auditAction(req, session, "media.product_delete", id, {
      template_id: templateId,
      objects: result.deleted,
      bytes: result.bytes,
    });
    return apiJson(result);
  } catch (e) {
    return mediaErrorResponse(e);
  }
}
