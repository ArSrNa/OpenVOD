// GET /api/admin/stats：控制台总览真实指标（intent.md「控制台总览」）
// 只返回已落地模块的统计：媒资总数 / 就绪 / 未入库（spec.md §1.4）、进行中转码任务（按状态，ADR-0008）、
// 播放端用户（总数 / 可用 / 已封禁，ADR-0004 users 表）；
// 存储 / 字幕 / 产物 / 元数据 / 会话等指标随对应里程碑接入后在同一端点扩展。
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
