// /api/admin/keys：密钥列表（spec.md §4.3；ADR-0006）
// 只读：返回 kid / method / mk_ver / 生成时间等元数据，**永不返回明文或封装 CEK**。
import { NextRequest, NextResponse } from "next/server";
import { apiJson, getAdminSession, unauthorized } from "@/lib/api";
import { keyErrorResponse, listMediaKeys } from "@/lib/keys";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<NextResponse> {
  const session = await getAdminSession(req);
  if (!session) return unauthorized();
  try {
    return apiJson(await listMediaKeys());
  } catch (e) {
    return keyErrorResponse(e);
  }
}
