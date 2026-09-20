// /api/admin/media/[id]：媒资详情 / 重命名 / 删除（intent.md 媒资管理操作，M1）
//   GET    详情：存储资产 + DB 元数据合并展示（probe 随转码流水线落地，当前 null）
//   PATCH  重命名：仅修改数据库展示名，绝不改动 original 文件名与媒资 ID
//   DELETE 删除：存储四分区该 id 全部对象 + DB 行（级联范围注记见 spec.md §2）
// POST [id]/transcode、[id]/subtitles、[id]/metadata 未实现 → 由 /api/admin/[...path] 返回 501。
import { NextRequest, NextResponse } from "next/server";
import { apiJson, auditAction, getAdminSession, unauthorized } from "@/lib/api";
import {
  deleteMedia,
  getMediaDetail,
  mediaErrorResponse,
  renameMedia,
} from "@/lib/media";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: NextRequest, ctx: Ctx): Promise<NextResponse> {
  const session = await getAdminSession(req);
  if (!session) return unauthorized();
  try {
    const { id } = await ctx.params;
    return apiJson(await getMediaDetail(id));
  } catch (e) {
    return mediaErrorResponse(e);
  }
}

export async function PATCH(req: NextRequest, ctx: Ctx): Promise<NextResponse> {
  const session = await getAdminSession(req);
  if (!session) return unauthorized();
  try {
    const { id } = await ctx.params;
    const body = (await req.json().catch(() => null)) as { title?: unknown } | null;
    if (typeof body?.title !== "string") {
      return NextResponse.json(
        { error: { code: "bad_request", message: "缺少 title 字段" } },
        { status: 400 },
      );
    }
    const row = await renameMedia(id, body.title);
    await auditAction(req, session, "media.rename", id, { title: row.title });
    return apiJson(row);
  } catch (e) {
    return mediaErrorResponse(e);
  }
}

export async function DELETE(req: NextRequest, ctx: Ctx): Promise<NextResponse> {
  const session = await getAdminSession(req);
  if (!session) return unauthorized();
  try {
    const { id } = await ctx.params;
    const result = await deleteMedia(id);
    await auditAction(req, session, "media.delete", id, { removed: result.removed });
    return apiJson(result);
  } catch (e) {
    return mediaErrorResponse(e);
  }
}
