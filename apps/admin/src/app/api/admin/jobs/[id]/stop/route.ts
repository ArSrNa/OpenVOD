// /api/admin/jobs/{id}/stop：取消转码任务（spec.md §5.1；2026-11-12 起执行中也可立即打断）
//   QUEUED / 租约已过期（worker 失联）：直接置 CANCELLED；
//   租约有效（worker 正在执行）：写 cancel_requested_at 取消请求，worker 2s 内轮询到即杀 ffmpeg / 中止拉源并收尾。
//   落 audit_logs（transcode.stop）。
import { NextRequest, NextResponse } from "next/server";
import { apiJson, auditAction, getAdminSession, unauthorized } from "@/lib/api";
import { jobsHub } from "@/lib/jobs-live";
import { stopTranscodeJob, transcodeErrorResponse } from "@/lib/transcode";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function POST(req: NextRequest, ctx: Ctx): Promise<NextResponse> {
  const session = await getAdminSession(req);
  if (!session) return unauthorized();
  try {
    const { id } = await ctx.params;
    const result = await stopTranscodeJob(id);
    jobsHub.poke(); // 「转码任务」页的 SSE 立即推送新状态
    await auditAction(req, session, "transcode.stop", id, {
      status: result.status,
      cancelling: result.cancelling,
    });
    return apiJson(result);
  } catch (e) {
    return transcodeErrorResponse(e);
  }
}
