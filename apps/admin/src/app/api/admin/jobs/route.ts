// /api/admin/jobs：转码任务列表（M2；管理端「转码任务」页）
import { NextRequest, NextResponse } from "next/server";
import { apiJson, getAdminSession, unauthorized } from "@/lib/api";
import { listTranscodeJobs, transcodeErrorResponse } from "@/lib/transcode";

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
