// /api/admin/jobs/{id}/restart：重启（重新入队）失败 / 手动停止的转码任务（spec.md §5.1/§5.3）
//   attempts 清零 + 清错误与租约 + 状态回 QUEUED，由 worker 重新认领。落 audit_logs（transcode.restart）。
import { NextRequest, NextResponse } from "next/server";
import { apiJson, auditAction, getAdminSession, unauthorized } from "@/lib/api";
import { jobsHub } from "@/lib/jobs-live";
import { restartTranscodeJob, transcodeErrorResponse } from "@/lib/transcode";
import { notifyWorkerWake } from "@/lib/worker-notify";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function POST(req: NextRequest, ctx: Ctx): Promise<NextResponse> {
  const session = await getAdminSession(req);
  if (!session) return unauthorized();
  try {
    const { id } = await ctx.params;
    const result = await restartTranscodeJob(id);
    jobsHub.poke(); // 「转码任务」页的 SSE 立即推送新状态
    // ADR-0017 门铃：同发起转码（带 job_id 供 invoked 模式定向认领；await 保证外呼发出，失败仅告警）；
    // stop 不需要通知（409 语义不依赖通道）
    await notifyWorkerWake([id]);
    await auditAction(req, session, "transcode.restart", id, { status: result.status });
    return apiJson(result);
  } catch (e) {
    return transcodeErrorResponse(e);
  }
}
