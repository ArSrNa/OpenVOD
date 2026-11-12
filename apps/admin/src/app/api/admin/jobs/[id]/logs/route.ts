// /api/admin/jobs/{id}/logs：转码任务日志尾部（ADR-0017 修订，2026-11-13）
// 数据来源是 Worker 覆盖写的 transcode_jobs.log_tail（环形 48KB）+ log_seq 版本号：
// 客户端带 after=<上次 seq>，未变化时 tail 为 null —— 轮询不重复回传整段文本。
// 为什么不做 SSE 推日志：管理端已有的任务 SSE 只推列表快照（变化才广播），
// 日志是高频追加，混进去会让每帧都携带全部任务文本；独立轮询按需拉、关闭抽屉即停。
import { NextRequest, NextResponse } from "next/server";
import { apiJson, getAdminSession, unauthorized } from "@/lib/api";
import { getTranscodeJobLogs, transcodeErrorResponse } from "@/lib/transcode";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: NextRequest, ctx: Ctx): Promise<NextResponse> {
  const session = await getAdminSession(req);
  if (!session) return unauthorized();
  try {
    const { id } = await ctx.params;
    const raw = Number(req.nextUrl.searchParams.get("after") ?? "0");
    const after = Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0;
    return apiJson(await getTranscodeJobLogs(id, after));
  } catch (e) {
    return transcodeErrorResponse(e);
  }
}
