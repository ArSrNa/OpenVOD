// PUT /api/admin/watermarks/[id]/image：上传 / 替换图片水印图（octet-stream ≤2 MiB，
// png / jpg / webp 按内容识别；覆盖式 PUT 同一键，扩展名变化清理旧对象，spec.md §10.2）
// GET：图片预览（列表缩略图 / 表单预览）—— S3 预签名 GET 302（字节不经管理端，同 cover 语义）；
// 文字型模板或图片未上传 → 404。
import { NextRequest, NextResponse } from "next/server";
import { apiJson, auditAction, getAdminSession, unauthorized } from "@/lib/api";
import { getStorage } from "@/lib/storage";
import {
  resolveWatermarkImageKey,
  uploadWatermarkImage,
  watermarkErrorResponse,
} from "@/lib/watermarks";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

const PRESIGN_TTL_SEC = 600;
const MAX_BYTES = 2 * 1024 * 1024;

export async function GET(req: NextRequest, ctx: Ctx): Promise<NextResponse> {
  const session = await getAdminSession(req);
  if (!session) return unauthorized();
  try {
    const { id } = await ctx.params;
    const key = await resolveWatermarkImageKey(id);
    if (!key) {
      return NextResponse.json(
        { error: { code: "not_found", message: "该水印模板没有图片资产" } },
        { status: 404 },
      );
    }
    const url = await (await getStorage()).presignGet(key, PRESIGN_TTL_SEC);
    return NextResponse.redirect(url, {
      status: 302,
      headers: { "Cache-Control": "no-store" },
    });
  } catch (e) {
    return watermarkErrorResponse(e);
  }
}

export async function PUT(req: NextRequest, ctx: Ctx): Promise<NextResponse> {
  const session = await getAdminSession(req);
  if (!session) return unauthorized();
  if (!req.body) {
    return NextResponse.json(
      { error: { code: "bad_request", message: "请求体为空（应携带图片字节流）" } },
      { status: 400 },
    );
  }
  try {
    const { id } = await ctx.params;
    // ≤2 MiB 上限内读入内存（魔数识别 + ffprobe 探测都需要完整字节）
    const bytes = new Uint8Array(await req.arrayBuffer());
    if (bytes.length > MAX_BYTES) {
      return NextResponse.json(
        { error: { code: "bad_request", message: "水印图片超过 2 MiB 上限" } },
        { status: 400 },
      );
    }
    const item = await uploadWatermarkImage(id, bytes);
    await auditAction(req, session, "watermark.image_upload", id, {
      key: item.image_key,
      bytes: item.image_bytes,
      width: item.image_width,
      height: item.image_height,
    });
    return apiJson({ item }, 201);
  } catch (e) {
    return watermarkErrorResponse(e);
  }
}
