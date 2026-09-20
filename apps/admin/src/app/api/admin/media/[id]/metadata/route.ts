// POST /api/admin/media/{id}/metadata：生成元数据（intent.md「更多 → 生成元数据」）
// ffprobe 探测 original → 原始输出落 `metadata/{id}/probe.json`（spec.md §1.3），
// 归一化摘要（宽高 / 帧率 / 色彩空间 / 编码等）回写 `media.probe` + `media.duration_ms`。
// 幂等可重试；成功后详情弹窗即可展示结构化元数据。
import { NextRequest, NextResponse } from "next/server";
import { apiJson, auditAction, getAdminSession, unauthorized } from "@/lib/api";
import { mediaErrorResponse } from "@/lib/media";
import { generateMetadata } from "@/lib/probe";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

type Ctx = { params: Promise<{ id: string }> };

export async function POST(req: NextRequest, ctx: Ctx): Promise<NextResponse> {
  const session = await getAdminSession(req);
  if (!session) return unauthorized();
  try {
    const { id } = await ctx.params;
    const result = await generateMetadata(id);
    await auditAction(req, session, "media.metadata_generate", id, {
      probeKey: result.probeKey,
      durationMs: result.summary.durationMs,
    });
    return apiJson(result, 200);
  } catch (e) {
    return mediaErrorResponse(e);
  }
}
