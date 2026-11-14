// /api/admin/keys/{mediaId}/rotate：CEK 轮换（spec.md §4.4；ADR-0006 §6）
// 语义：重转码该媒资**全部加密模板产物**。管理端生成一次计划密钥（MK 封装形态）固化进
// 本批全部轮换任务（transcode_jobs.key_plan），Worker 产物上传成功后整行替换 hls_keys。
// 与 rotate-mk 的区别：MK 轮换只重封装、不动媒体字节；CEK 轮换必须重转码（短时维护窗口）。
import { after, NextRequest, NextResponse } from "next/server";
import { apiJson, auditAction, getAdminSession, unauthorized } from "@/lib/api";
import { keyErrorResponse, rotateMediaCek } from "@/lib/keys";
import { jobsHub } from "@/lib/jobs-live";
import { DETACHED_WAKE_TIMEOUT_MS, notifyWorkerWake } from "@/lib/worker-notify";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ mediaId: string }> };

export async function POST(req: NextRequest, ctx: Ctx): Promise<NextResponse> {
  const session = await getAdminSession(req);
  if (!session) return unauthorized();
  try {
    const { mediaId } = await ctx.params;
    const body = await req.json().catch(() => ({}));
    const result = await rotateMediaCek(mediaId, body);
    jobsHub.poke(); // 有写入：让「转码任务」页的 SSE 立即推新任务，不必等下一轮观察
    const jobIds = result.jobs.map((j) => j.job_id);
    await auditAction(req, session, "key.rotate_cek", mediaId, {
      kid: result.kid,
      job_ids: jobIds,
      template_ids: result.jobs.map((j) => j.template_id),
      skipped: result.skipped,
    });
    // ADR-0017 门铃：响应之后再唤醒（轮换是全量重转码，同步唤醒下会等很久）；
    // job_ids 供 invoked 模式定向认领，http 模式忽略
    after(() => notifyWorkerWake(jobIds, { timeoutMs: DETACHED_WAKE_TIMEOUT_MS }));
    return apiJson(result, 202);
  } catch (e) {
    return keyErrorResponse(e);
  }
}
