// GET /api/admin/stats：控制台总览真实指标（intent.md「控制台总览」）
// 数据库运营指标 + S3 已用空间 / 字幕 / 转码产物组 / 元数据对象，不统计播放会话。
import { NextRequest, NextResponse } from "next/server";
import { apiError, apiJson, getAdminSession, unauthorized } from "@/lib/api";
import { getDashboardStats } from "@/lib/stats";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<NextResponse> {
  const session = await getAdminSession(req);
  if (!session) return unauthorized();
  try {
    return apiJson(await getDashboardStats());
  } catch (e) {
    console.error("[stats] 总览统计失败:", e);
    return apiError("internal", (e as Error)?.message ?? "统计失败", 500);
  }
}
