// /api/admin/media/[id]/subtitles：字幕轨道列表 / 新建（spec.md §7.4；ADR-0009）
//   GET   轨道列表（is_default DESC, created_at ASC）+ 对象存在性 storage_ok
//   POST  新建轨道：查询参数 lang（BCP-47，兼容 zh_CN 写法）/ label / is_default；
//         请求体为**原始字幕字节流**（octet-stream，同 §2 上传协议）：`.vtt` 直接使用，
//         `.srt` 由服务端自动转换为 WebVTT（§7.3）——存储对象恒为 `{trackId}.vtt`
//         → 服务端结构化校验（§7.3）→ 生成 trackId → 写 proceed/{id}/subtitles/{trackId}.vtt
//         → 落 media_subtitles（status=READY）→ 审计 subtitle.create
// 说明：语言与校验失败原因直接回显（400）；同媒资同语言 409；媒资未入库 404。
import { NextRequest, NextResponse } from "next/server";
import { apiJson, auditAction, getAdminSession, unauthorized } from "@/lib/api";
import {
  createSubtitle,
  defaultSubtitleDeps,
  listSubtitles,
  subtitleErrorResponse,
} from "@/lib/subtitles";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: NextRequest, ctx: Ctx): Promise<NextResponse> {
  const session = await getAdminSession(req);
  if (!session) return unauthorized();
  try {
    const { id } = await ctx.params;
    return apiJson(await listSubtitles(id, defaultSubtitleDeps));
  } catch (e) {
    return subtitleErrorResponse(e);
  }
}

export async function POST(req: NextRequest, ctx: Ctx): Promise<NextResponse> {
  const session = await getAdminSession(req);
  if (!session) return unauthorized();
  if (!req.body) {
    return NextResponse.json(
      { error: { code: "bad_request", message: "请求体为空（应携带 .vtt 字幕文件字节流）" } },
      { status: 400 },
    );
  }
  const params = req.nextUrl.searchParams;
  const isDefaultRaw = (params.get("is_default") ?? "").trim().toLowerCase();
  try {
    const { id } = await ctx.params;
    // 字幕文件上限 5 MiB（spec.md §7.2），整体读入内存后校验
    const bytes = new Uint8Array(await req.arrayBuffer());
    const item = await createSubtitle(
      id,
      {
        lang: params.get("lang") ?? "",
        label: params.get("label") ?? "",
        isDefault: isDefaultRaw === "true" || isDefaultRaw === "1",
        createdBy: session.user.id,
        bytes,
      },
      defaultSubtitleDeps,
    );
    await auditAction(req, session, "subtitle.create", id, {
      track_id: item.id,
      lang: item.lang,
      label: item.label,
      is_default: item.is_default,
      bytes: item.bytes,
    });
    return apiJson({ item }, 201);
  } catch (e) {
    return subtitleErrorResponse(e);
  }
}
