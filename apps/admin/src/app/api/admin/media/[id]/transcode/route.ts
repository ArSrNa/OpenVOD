// /api/admin/media/{id}/transcode：发起转码（M2，ADR-0008/0014）
// 请求体 template_ids[]（多选）：校验（媒资 / 原始文件 / 每个模板 / 加密必须 HLS / 同媒资同模板无进行中任务）
// → 每个模板各快照入队一条 transcode_jobs。实际执行由 Worker 认领完成；此处不生成 ffmpeg argv（源参数未知，ADR-0014）。
import { NextRequest, NextResponse } from "next/server";
import { apiJson, auditAction, getAdminSession, unauthorized } from "@/lib/api";
import { jobsHub } from "@/lib/jobs-live";
import { submitTranscode, transcodeErrorResponse } from "@/lib/transcode";
import { notifyWorkerWake } from "@/lib/worker-notify";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function POST(req: NextRequest, ctx: Ctx): Promise<NextResponse> {
  const session = await getAdminSession(req);
  if (!session) return unauthorized();
  try {
    const { id } = await ctx.params;
    const body = await req.json().catch(() => null);
    const result = await submitTranscode(id, body);
    jobsHub.poke(); // 有写入：让「转码任务」页的 SSE 立即推新任务，不必等下一轮观察
    // ADR-0017 门铃：唤醒异步函数实例来认领本次任务。必须 await——响应返回后实例可能被冻结，
    // 未发出的外呼会丢（上层已限时，失败仅告警不改变 202）。job_ids 供 invoked 模式定向认领，http 模式忽略
    await notifyWorkerWake(result.jobs.map((j) => j.job_id));
    await auditAction(req, session, "media.transcode_submit", id, {
      job_ids: result.jobs.map((j) => j.job_id),
      template_ids: result.jobs.map((j) => j.template_id),
      // 水印关联溯源（spec.md §10.7）：多选模板故为列表，null 已被过滤
      watermark_ids: result.jobs.map((j) => j.watermark_id).filter((v): v is string => v != null),
    });
    return apiJson(result, 202);
  } catch (e) {
    return transcodeErrorResponse(e);
  }
}
