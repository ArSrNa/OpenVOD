// POST /api/admin/media/upload：原视频上传入库（spec.md §1.3 / §2，M1）
// 协议：原始文件字节流作为请求体（Content-Type: application/octet-stream），
// 文件名 / 展示名走查询参数——流式直传不经过 multipart 缓冲，大文件内存占用恒定：
//   POST /api/admin/media/upload?filename=video.mp4&title=标题
// 成功即生成唯一数字媒资 ID（original/{id}.{ext}，ID 落库，spec.md §1.3）。
// 大文件 S3 分片直传（presignPut multipart）留待后续（ADR-0005 上传路径演进）。
import { NextRequest, NextResponse } from "next/server";
import { apiJson, auditAction, getAdminSession, unauthorized } from "@/lib/api";
import { mediaErrorResponse, uploadOriginal } from "@/lib/media";

export const dynamic = "force-dynamic";
export const maxDuration = 600;

export async function POST(req: NextRequest): Promise<NextResponse> {
  const session = await getAdminSession(req);
  if (!session) return unauthorized();
  if (!req.body) {
    return NextResponse.json(
      { error: { code: "bad_request", message: "请求体为空（应携带原始文件字节流）" } },
      { status: 400 },
    );
  }
  const filename = req.nextUrl.searchParams.get("filename") ?? "";
  if (!filename) {
    return NextResponse.json(
      { error: { code: "bad_request", message: "缺少 filename 查询参数" } },
      { status: 400 },
    );
  }
  try {
    const result = await uploadOriginal({
      filename,
      title: req.nextUrl.searchParams.get("title"),
      body: req.body,
    });
    await auditAction(req, session, "media.upload", result.id, {
      key: result.key,
      size: result.size,
      title: result.title,
    });
    return apiJson(result, 201);
  } catch (e) {
    return mediaErrorResponse(e);
  }
}
