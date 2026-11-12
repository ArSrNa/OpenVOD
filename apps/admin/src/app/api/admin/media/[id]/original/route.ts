// GET /api/admin/media/[id]/original：原视频预览（intent.md「预览：弹窗直接播放 original」）
// S3 预签名 GET 302 重定向（Range 由对象存储处理，字节不经管理端；
// 配置 STORAGE_CDN_BASE_URL 时 302 目标 origin 替换为加速域名，ADR-0005）。
// 管理端私有内容：no-store，仅供 better-auth 会话（video 标签同源自动带 Cookie）。
import { NextRequest, NextResponse } from "next/server";
import { apiError, getAdminSession, unauthorized } from "@/lib/api";
import { mediaErrorResponse, resolveOriginalKey } from "@/lib/media";
import { getStorage } from "@/lib/storage";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

const PRESIGN_TTL_SEC = 600;

export async function GET(req: NextRequest, ctx: Ctx): Promise<NextResponse> {
  const session = await getAdminSession(req);
  if (!session) return unauthorized();
  try {
    const { id } = await ctx.params;
    const key = await resolveOriginalKey(id);
    if (!key) {
      return apiError("not_found", "原始文件不存在", 404);
    }
    const url = await (await getStorage()).presignGet(key, PRESIGN_TTL_SEC);
    return NextResponse.redirect(url, {
      status: 302,
      headers: { "Cache-Control": "no-store" },
    });
  } catch (e) {
    return mediaErrorResponse(e);
  }
}
