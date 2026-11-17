// POST /api/admin/media/upload/init?filename=video.mp4&title=标题
// 直传第一步（ADR-0005 上传路径）：生成媒资 ID + 占位行，返回 original/{id}.{ext} 的预签名 PUT URL。
// 之后的字节由浏览器直传对象存储，管理端不再接触文件内容。
import { NextRequest, NextResponse } from "next/server";
import { apiError, apiJson, getAdminSession, unauthorized } from "@/lib/api";
import { beginUpload, mediaErrorResponse } from "@/lib/media";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest): Promise<NextResponse> {
  const session = await getAdminSession(req);
  if (!session) return unauthorized();
  const filename = req.nextUrl.searchParams.get("filename") ?? "";
  if (!filename) {
    return apiError("bad_request", "缺少 filename 查询参数", 400);
  }
  try {
    const result = await beginUpload({
      filename,
      title: req.nextUrl.searchParams.get("title"),
    });
    return apiJson(result, 201);
  } catch (e) {
    return mediaErrorResponse(e);
  }
}
