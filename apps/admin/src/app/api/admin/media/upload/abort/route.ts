// POST /api/admin/media/upload/abort  { id }
// 直传清理（ADR-0005 上传路径）：取消 / 失败后丢弃占位行与残留对象，避免半截媒资长期占位。
// 已产生转码产物时拒绝（409）——此时媒资已成立，应当走 DELETE /api/admin/media/{id}。
import { NextRequest, NextResponse } from "next/server";
import { apiError, apiJson, auditAction, getAdminSession, unauthorized } from "@/lib/api";
import { abortUpload, mediaErrorResponse } from "@/lib/media";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest): Promise<NextResponse> {
  const session = await getAdminSession(req);
  if (!session) return unauthorized();
  const body = (await req.json().catch(() => null)) as { id?: unknown } | null;
  const id = typeof body?.id === "string" ? body.id : "";
  if (!id) return apiError("bad_request", "缺少 id", 400);
  try {
    const result = await abortUpload(id);
    if (result.aborted) {
      await auditAction(req, session, "media.upload_abort", id);
    }
    return apiJson(result);
  } catch (e) {
    return mediaErrorResponse(e);
  }
}
