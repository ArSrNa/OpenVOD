// GET /api/admin/media/[id]/original：原视频预览流（intent.md「预览：弹窗直接播放 original」）
// local 模式：Range 字节区间流式代理（video 标签拖动进度条）；
// s3 模式：预签名 GET 302 重定向（Range 由对象存储处理，字节不经管理端）。
// 管理端私有内容：no-store，仅供 better-auth 会话（video 标签同源自动带 Cookie）。
import { NextRequest, NextResponse } from "next/server";
import { getAdminSession, unauthorized } from "@/lib/api";
import { mediaErrorResponse, resolveOriginalKey, contentTypeFor } from "@/lib/media";
import { getStorage, getStorageDriver } from "@/lib/storage";

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
      return NextResponse.json(
        { error: { code: "not_found", message: "原始文件不存在" } },
        { status: 404 },
      );
    }
    const storage = getStorage();

    if (getStorageDriver() === "s3") {
      const url = await storage.presignGet(key, PRESIGN_TTL_SEC);
      return NextResponse.redirect(url, {
        status: 302,
        headers: { "Cache-Control": "no-store" },
      });
    }

    const stat = await storage.stat(key);
    if (!stat) {
      return NextResponse.json(
        { error: { code: "not_found", message: "原始文件不存在" } },
        { status: 404 },
      );
    }
    const size = stat.size;
    const baseHeaders: Record<string, string> = {
      "Content-Type": contentTypeFor(key.split(".").pop()?.toLowerCase() ?? ""),
      "Accept-Ranges": "bytes",
      "Cache-Control": "no-store",
    };

    const range = req.headers.get("range");
    if (!range) {
      const stream = storage.streamRange!(key, 0, size - 1);
      return new NextResponse(stream, {
        status: 200,
        headers: { ...baseHeaders, "Content-Length": String(size) },
      });
    }

    // 单区间 Range 解析：bytes=start-end / bytes=start- / bytes=-suffix
    const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    let start = 0;
    let end = size - 1;
    if (!m) {
      return new NextResponse(null, {
        status: 416,
        headers: { "Content-Range": `bytes */${size}` },
      });
    }
    if (m[1] && m[2]) {
      start = parseInt(m[1], 10);
      end = Math.min(parseInt(m[2], 10), size - 1);
    } else if (m[1]) {
      start = parseInt(m[1], 10);
    } else if (m[2]) {
      start = Math.max(0, size - parseInt(m[2], 10)); // 后缀区间：最后 N 字节
    }
    if (start > end || start >= size) {
      return new NextResponse(null, {
        status: 416,
        headers: { "Content-Range": `bytes */${size}` },
      });
    }
    const stream = storage.streamRange!(key, start, end);
    return new NextResponse(stream, {
      status: 206,
      headers: {
        ...baseHeaders,
        "Content-Range": `bytes ${start}-${end}/${size}`,
        "Content-Length": String(end - start + 1),
      },
    });
  } catch (e) {
    return mediaErrorResponse(e);
  }
}
