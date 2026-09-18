// POST /api/admin/media/[id]/cover?filename=poster.png：上传封面（intent.md「上传封面」）
// 落键 cover/{id}/poster.{ext}（spec.md §1.3）并回写 DB posterKey。
// 请求体：原始图片字节流（与原视频上传同协议，见 upload/route.ts）。
import { NextRequest, NextResponse } from "next/server";
import { apiJson, auditAction, getAdminSession, unauthorized } from "@/lib/api";
import { mediaErrorResponse, uploadCover } from "@/lib/media";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function POST(req: NextRequest, ctx: Ctx): Promise<NextResponse> {
  const session = await getAdminSession(req);
  if (!session) return unauthorized();
  if (!req.body) {
    return NextResponse.json(
      { error: { code: "bad_request", message: "请求体为空（应携带图片字节流）" } },
      { status: 400 },
    );
  }
  const filename = req.nextUrl.searchParams.get("filename") ?? "";
  if (!filename) {
    return NextResponse.json(
      { error: { code: "bad_request", message: "缺少 filename 查询参数" } },
      { status: 400 },
    );
  }
  try {
    const { id } = await ctx.params;
    const result = await uploadCover(id, filename, req.body);
    await auditAction(req, session, "media.cover_upload", id, { key: result.key });
    return apiJson(result, 201);
  } catch (e) {
    return mediaErrorResponse(e);
  }
}
