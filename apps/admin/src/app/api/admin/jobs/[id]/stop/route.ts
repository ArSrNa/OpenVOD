// /api/admin/jobs/{id}/stop：停止（取消）转码任务（spec.md §5.1）
//   QUEUED：撤下队列，不再被认领；执行中但租约已过期（worker 失联 / 已死）：安全终止；
//   租约有效（worker 正在执行）→ 409 拒绝（任务状态会被 worker 覆盖）。落 audit_logs（transcode.stop）。
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
    await auditAction(req, session, "transcode.stop", id, { status: result.status });
    return apiJson(result);
  } catch (e) {
    return transcodeErrorResponse(e);
  }
}
