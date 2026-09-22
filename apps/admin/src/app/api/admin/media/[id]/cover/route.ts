// POST /api/admin/media/[id]/cover?filename=poster.png：上传封面（intent.md「上传封面」）
// 落键 cover/{id}/poster.{ext}（spec.md §1.3）并回写 DB posterKey。
// 请求体：原始图片字节流（与原视频上传同协议，见 upload/route.ts）。
// GET：封面图片读取（媒资列表首列缩略图 / 详情展示，spec.md §3.1）——
// S3 预签名 GET 302 重定向（字节不经管理端，同 original/route.ts）。
// 管理端私有内容：no-store，仅供 better-auth 会话（img 标签同源自动带 Cookie）。
import { NextRequest, NextResponse } from "next/server";
import { apiJson, auditAction, getAdminSession, unauthorized } from "@/lib/api";
import { mediaErrorResponse, resolvePosterKey, uploadCover } from "@/lib/media";
import { getStorage } from "@/lib/storage";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

const PRESIGN_TTL_SEC = 600;

export async function GET(req: NextRequest, ctx: Ctx): Promise<NextResponse> {
  const session = await getAdminSession(req);
  if (!session) return unauthorized();
  try {
    const { id } = await ctx.params;
    const key = await resolvePosterKey(id);
    if (!key) {
      return NextResponse.json(
        { error: { code: "not_found", message: "该媒资尚未设置封面" } },
        { status: 404 },
      );
    }
    const url = await getStorage().presignGet(key, PRESIGN_TTL_SEC);
    return NextResponse.redirect(url, {
      status: 302,
      headers: { "Cache-Control": "no-store" },
    });
  } catch (e) {
    return mediaErrorResponse(e);
  }
}

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
