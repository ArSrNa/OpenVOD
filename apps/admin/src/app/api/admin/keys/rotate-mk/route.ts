// /api/admin/keys/rotate-mk：MK 轮换（spec.md §4.4；ADR-0006 §6）
// 用行记录自身的 mk_ver 解封 CEK、以 active MK（MASTER_KEYS 最大版本）重新封装；
// 不改动媒体字节，**无需重转码**。v1 同步执行；超大数据量演进为任务化分批。
import { NextRequest, NextResponse } from "next/server";
import { apiJson, auditAction, getAdminSession, unauthorized } from "@/lib/api";
import { keyErrorResponse, rotateMasterKeys } from "@/lib/keys";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest): Promise<NextResponse> {
  const session = await getAdminSession(req);
  if (!session) return unauthorized();
  try {
    const body = await req.json().catch(() => null);
    const result = await rotateMasterKeys(body);
    await auditAction(req, session, "key.rotate_mk", null, {
      rotated: result.rotated,
      failed: result.failed,
      to_ver: result.to_ver,
    });
    return apiJson(result);
  } catch (e) {
    return keyErrorResponse(e);
  }
}
