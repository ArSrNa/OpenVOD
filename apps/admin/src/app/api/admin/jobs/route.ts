// /api/admin/jobs：转码任务列表 / 批量删除（M2；管理端「转码任务」页）
//   GET     列表（最近 200 条）
//   DELETE  批量删除：{ids[]}（≤200）；仅非进行中可删，进行中的在响应 skipped 里回报
import { TranscodeJobsDeleteRequest } from "@openvod/contracts";
import { NextRequest, NextResponse } from "next/server";
import { apiError, apiJson, auditAction, getAdminSession, unauthorized } from "@/lib/api";
import { jobsHub } from "@/lib/jobs-live";
import { deleteTranscodeJobs, listTranscodeJobs, transcodeErrorResponse } from "@/lib/transcode";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<NextResponse> {
  const session = await getAdminSession(req);
  if (!session) return unauthorized();
  try {
    return apiJson(await listTranscodeJobs());
  } catch (e) {
    return transcodeErrorResponse(e);
  }
}

export async function DELETE(req: NextRequest): Promise<NextResponse> {
  const session = await getAdminSession(req);
  if (!session) return unauthorized();
  try {
    const body = await req.json().catch(() => null);
    const parsed = TranscodeJobsDeleteRequest.safeParse(body);
    if (!parsed.success) {
      return apiError("bad_request", parsed.error.issues[0]?.message ?? "参数不合法", 400);
    }
    const result = await deleteTranscodeJobs(parsed.data.ids);
    jobsHub.poke(); // 「转码任务」页的 SSE 立即推新快照，不用等下一轮观察
    await auditAction(req, session, "transcode.delete", null, {
      ids: parsed.data.ids,
      deleted: result.deleted,
      skipped: result.skipped,
    });
    return apiJson(result);
  } catch (e) {
    return transcodeErrorResponse(e);
  }
}
