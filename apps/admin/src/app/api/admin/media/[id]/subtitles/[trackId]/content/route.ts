// /api/admin/media/[id]/subtitles/[trackId]/content：读取 / 覆盖字幕文本（spec.md §7.4）
//   GET  读取该轨道的 WebVTT（管理端「字幕预览」用：原视频 + 该字幕轨，同源 <track> 引用）；
//        响应 text/vtt + no-store（§2 通用约定：管理端 API 一律不缓存）
//   PUT  请求体为**原始字幕字节流**（octet-stream）：`.vtt` / `.srt`（SRT 自动转 VTT，§7.3）
//        → 同一校验 → 就地覆盖同一对象（trackId 与存储键不变）→ 更新 bytes / updated_at
//        → 审计 subtitle.update。
// 分发端字幕响应 no-store，故编辑后播放端下一次请求即取到新文本（spec.md §7.2/§7.5）。
import { NextRequest, NextResponse } from "next/server";
import { SUBTITLE_CONTENT_TYPE } from "@openvod/shared";
import { apiError, apiJson, auditAction, getAdminSession, unauthorized } from "@/lib/api";
import {
  defaultSubtitleDeps,
  readSubtitleContent,
  replaceSubtitleContent,
  subtitleErrorResponse,
} from "@/lib/subtitles";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string; trackId: string }> };

export async function GET(req: NextRequest, ctx: Ctx): Promise<NextResponse> {
  const session = await getAdminSession(req);
  if (!session) return unauthorized();
  try {
    const { id, trackId } = await ctx.params;
    const { body } = await readSubtitleContent(id, trackId, defaultSubtitleDeps);
    // 取底层 ArrayBuffer 作为响应体（Uint8Array<ArrayBufferLike> 不被 BodyInit 接受；
    // 字节数上限 5 MiB，见 spec.md §7.2 的 SUBTITLE_MAX_BYTES）
    const buf = body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer;
    return new NextResponse(buf, {
      status: 200,
      headers: {
        "Content-Type": SUBTITLE_CONTENT_TYPE,
        "Content-Length": String(body.byteLength),
        "Cache-Control": "no-store",
      },
    });
  } catch (e) {
    return subtitleErrorResponse(e);
  }
}

export async function PUT(req: NextRequest, ctx: Ctx): Promise<NextResponse> {
  const session = await getAdminSession(req);
  if (!session) return unauthorized();
  if (!req.body) {
    return apiError("bad_request", "请求体为空（应携带 .vtt 字幕文件字节流）", 400);
  }
  try {
    const { id, trackId } = await ctx.params;
    const bytes = new Uint8Array(await req.arrayBuffer());
    const item = await replaceSubtitleContent(id, trackId, bytes, defaultSubtitleDeps);
    await auditAction(req, session, "subtitle.update", id, {
      track_id: item.id,
      lang: item.lang,
      label: item.label,
      bytes: item.bytes,
      content_replaced: true,
    });
    return apiJson({ item });
  } catch (e) {
    return subtitleErrorResponse(e);
  }
}
