// /api/admin/media/{id}/transcode：发起转码（M2，ADR-0008/0014）
// 校验（媒资 / 原始文件 / 模板 / 加密必须 HLS / 同媒资无进行中任务）→ 快照模板入队 transcode_jobs。
// 实际执行由 Worker 认领完成；此处不生成 ffmpeg argv（源参数未知，ADR-0014）。
import { NextRequest, NextResponse } from "next/server";
import { apiJson, auditAction, getAdminSession, unauthorized } from "@/lib/api";
import { submitTranscode, transcodeErrorResponse } from "@/lib/transcode";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function POST(req: NextRequest, ctx: Ctx): Promise<NextResponse> {
  const session = await getAdminSession(req);
  if (!session) return unauthorized();
  try {
    const { id } = await ctx.params;
    const body = await req.json().catch(() => null);
    const result = await submitTranscode(id, body);
    await auditAction(req, session, "media.transcode_submit", id, { job_id: result.job_id });
    return apiJson(result, 202);
  } catch (e) {
    return transcodeErrorResponse(e);
  }
}
