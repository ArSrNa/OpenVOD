// 受保护的控制台业务 API（ADR-0010 端点语义平移到 /api/admin/*）
// 已实现的具体路由优先于本 catch-all；未列出的路径统一会话守卫 + 501 占位。
//   已实现（M1 媒资管理）：/api/admin/media、/media/upload、/media/[id]（GET/PATCH/DELETE）、
//                         /media/[id]/original、/media/[id]/cover、/media/[id]/metadata（生成元数据）
//   已实现（M3 产物）：/media/[id]/preview-play（解密播放预览，走分发端签名链路）、
//                      /media/[id]/products/[templateId]（DELETE 删除一套模板产物）
//   已实现（模板管理，ADR-0014）：/api/admin/templates（GET/POST）、/templates/[id]（GET/PATCH/DELETE）
//   已实现（密钥管理，spec.md §4）：/api/admin/keys、/keys/[mediaId]、/keys/mk、/keys/rotate-mk、
//                         /keys/[mediaId]/rotate（CEK 轮换 = 重转码全部加密产物，spec.md §4.4）
//   已实现（转码 M2，ADR-0008）：/api/admin/media/[id]/transcode（POST 发起入队）、/api/admin/jobs（GET 任务列表）、
//                         /api/admin/jobs/stream（SSE 实时推送，spec.md §2.1）、
//                         /api/admin/jobs/[id]/stop、/api/admin/jobs/[id]/restart（停止 / 重启，spec.md §5.1）
//   已实现（总览统计）：/api/admin/stats（媒资总数 / 就绪 / 未入库 + 进行中任务按状态计数 + 播放端用户总数/可用/已封禁）
//   已实现（播放端用户，ADR-0004 users 表 / ADR-0007）：/api/admin/users（GET/POST）、/users/[id]（GET/PATCH/DELETE）、
//                         /users/[id]/password（POST 重置口令）、/users/[id]/revoke-sessions（POST 手动吊销会话）
//   已实现（字幕管理，spec.md §7 / ADR-0009）：/media/[id]/subtitles（GET 列表 / POST 新建）、
//                         /media/[id]/subtitles/[trackId]（PATCH 元信息 / DELETE 轨道）、
//                         /media/[id]/subtitles/[trackId]/content（PUT 覆盖文本）
//   已实现（分类与自定义元数据，spec.md §8 / ADR-0016）：/api/admin/categories（GET 列表 / POST 新建）、
//                         /categories/[id]（PATCH 更新 / DELETE 删除）；
//                         /media/[id] 的 PATCH 已扩展为「重命名 + 描述 / 标签 / 分类」
//   已实现（水印模板，spec.md §10 / ADR-0018）：/api/admin/watermarks（GET 列表 / POST 新建）、
//                         /watermarks/[id]（GET 详情 / PATCH 更新 / DELETE 删除）、
//                         /watermarks/[id]/image（PUT 上传替换图片 / GET 图片预览 302）
import { NextRequest, NextResponse } from "next/server";
import { apiError, unauthorized } from "@/lib/api";
import { getAuth } from "@/lib/auth";

// 占位响应在调用时生成（apiError 自带 Cache-Control: no-store），不再复用一个模块级实例
function notImplemented(): NextResponse {
  return apiError("not_implemented", "scaffold：路由随 specification 实现（ADR-0004/0008）", 501);
}

async function handle(req: NextRequest): Promise<NextResponse> {
  const auth = await getAuth();
  const session = await auth.api.getSession({ headers: req.headers });
  if (!session) {
    return unauthorized();
  }
  void new URL(req.url); // specification：按 path 分发到各业务 handler
  return notImplemented();
}

export const GET = handle;
export const POST = handle;
export const PUT = handle;
export const PATCH = handle;
export const DELETE = handle;
