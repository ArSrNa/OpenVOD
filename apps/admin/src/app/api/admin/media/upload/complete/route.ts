// POST /api/admin/media/upload/complete  { id }
// 直传第三步（ADR-0005 上传路径）：对象写完后由前端回调——HEAD 确认对象存在、导出 custom.json，
// 响应发送后异步自动生成元数据（同流式上传：metadata.status="pending"，best-effort 失败只告警）。
import { after, NextRequest, NextResponse } from "next/server";
import { apiError, apiJson, auditAction, getAdminSession, unauthorized } from "@/lib/api";
import { completeUpload, mediaErrorResponse } from "@/lib/media";
import { tryGenerateMetadata } from "@/lib/probe";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest): Promise<NextResponse> {
  const session = await getAdminSession(req);
  if (!session) return unauthorized();
  const body = (await req.json().catch(() => null)) as { id?: unknown } | null;
  const id = typeof body?.id === "string" ? body.id : "";
  if (!id) return apiError("bad_request", "缺少 id", 400);
  try {
    const result = await completeUpload(id);
    after(async () => {
      await tryGenerateMetadata(result.id);
    });
    await auditAction(req, session, "media.upload", result.id, {
      key: result.key,
      size: result.size,
      title: result.title,
      metadata_auto: "scheduled",
      transport: "presigned_put",
    });
    return apiJson({ ...result, metadata: { status: "pending" } });
  } catch (e) {
    return mediaErrorResponse(e);
  }
}
