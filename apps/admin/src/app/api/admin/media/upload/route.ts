// POST /api/admin/media/upload：原视频上传入库（spec.md §1.3 / §2，M1）
// 协议：原始文件字节流作为请求体（Content-Type: application/octet-stream），
// 文件名 / 展示名走查询参数——流式直传不经过 multipart 缓冲，大文件内存占用恒定：
//   POST /api/admin/media/upload?filename=video.mp4&title=标题
// 成功即生成唯一数字媒资 ID（original/{id}.ext，ID 落库，spec.md §1.3）。
// 2026-09-30：上传完毕后**异步自动生成元数据**（ffprobe → probe.json + media.probe/duration_ms，spec.md §2.1）：
// 响应立即返回（`metadata.status="pending"`），探测在 `after()` 中于响应发送后执行；best-effort ——
// 探测失败只告警（可手动「生成元数据」重跑），前端按递增间隔轮询详情直至 probe 就绪（lib/metadata-poll.ts）。
// 大文件 S3 分片直传（presignPut multipart）留待后续（ADR-0005 上传路径演进）。
import { after, NextRequest, NextResponse } from "next/server";
import { apiError, apiJson, auditAction, getAdminSession, unauthorized } from "@/lib/api";
import { mediaErrorResponse, uploadOriginal } from "@/lib/media";
import { tryGenerateMetadata } from "@/lib/probe";

export const dynamic = "force-dynamic";
export const maxDuration = 600;

export async function POST(req: NextRequest): Promise<NextResponse> {
  const session = await getAdminSession(req);
  if (!session) return unauthorized();
  if (!req.body) {
    return apiError("bad_request", "请求体为空（应携带原始文件字节流）", 400);
  }
  const filename = req.nextUrl.searchParams.get("filename") ?? "";
  if (!filename) {
    return apiError("bad_request", "缺少 filename 查询参数", 400);
  }
  try {
    const result = await uploadOriginal({
      filename,
      title: req.nextUrl.searchParams.get("title"),
      body: req.body,
    });
    // 异步触发元数据生成（spec.md §2.1）：`after()` 在响应发送后执行，探测失败只告警（不抛）；
    // 前端收 `metadata.status="pending"` 后按递增间隔轮询详情直至 probe 就绪（lib/metadata-poll.ts）
    after(async () => {
      await tryGenerateMetadata(result.id);
    });
    await auditAction(req, session, "media.upload", result.id, {
      key: result.key,
      size: result.size,
      title: result.title,
      metadata_auto: "scheduled",
    });
    return apiJson({ ...result, metadata: { status: "pending" } }, 201);
  } catch (e) {
    return mediaErrorResponse(e);
  }
}
