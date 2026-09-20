// /api/admin/keys/mk：MK 版本状态（spec.md §4.3）
// 只暴露版本号与各版本密钥用量，不暴露任何密钥材料。
import { NextRequest, NextResponse } from "next/server";
import { apiJson, getAdminSession, unauthorized } from "@/lib/api";
import { keyErrorResponse, masterKeyStatus } from "@/lib/keys";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<NextResponse> {
  const session = await getAdminSession(req);
  if (!session) return unauthorized();
  try {
    return apiJson(await masterKeyStatus());
  } catch (e) {
    return keyErrorResponse(e);
  }
}
