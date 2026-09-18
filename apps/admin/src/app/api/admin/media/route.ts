// GET /api/admin/media：媒资列表（spec.md §1.4 存储视角 + §2 DB 展示名/状态合并）
// 媒资集合以 original/ 分区为准（original/{id}.{ext}，id = 纯数字媒资 ID）；
// proceed / cover / metadata 三个分区只按 id 归组补充资产数量，不反向定义媒资。
import { NextRequest, NextResponse } from "next/server";
import { getAdminSession, unauthorized } from "@/lib/api";
import { listMedia, mediaErrorResponse } from "@/lib/media";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<NextResponse> {
  const session = await getAdminSession(req);
  if (!session) return unauthorized();
  try {
    const data = await listMedia();
    return NextResponse.json(data, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return mediaErrorResponse(e);
  }
}
