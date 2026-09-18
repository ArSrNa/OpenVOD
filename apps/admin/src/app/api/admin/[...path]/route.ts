// 受保护的控制台业务 API（ADR-0010 端点语义平移到 /api/admin/*）
// 已实现的具体路由优先于本 catch-all；未列出的路径统一会话守卫 + 501 占位。
//   已实现（M1 媒资管理）：/api/admin/media、/media/upload、/media/[id]（GET/PATCH/DELETE）、
//                         /media/[id]/original、/media/[id]/cover、/media/[id]/metadata（生成元数据）
//   已实现（M3 产物）：/media/[id]/preview-play（解密播放预览，走分发端签名链路）、
//                      /media/[id]/products/[templateId]（DELETE 删除一套模板产物）
//   已实现（模板管理，ADR-0014）：/api/admin/templates（GET/POST）、/templates/[id]（GET/PATCH/DELETE）
//   已实现（密钥管理，spec.md §4）：/api/admin/keys、/keys/[mediaId]、/keys/mk、/keys/rotate-mk
//   已实现（转码 M2，ADR-0008）：/api/admin/media/[id]/transcode（POST 发起入队）、/api/admin/jobs（GET 任务列表）、
//                         /api/admin/jobs/stream（SSE 实时推送，spec.md §2.1）、
//                         /api/admin/jobs/[id]/stop、/api/admin/jobs/[id]/restart（停止 / 重启，spec.md §5.1）
//   TODO 501 占位（随里程碑落地，intent.md 标注）：
//     - /media/[id]/subtitles      字幕上传/管理（M4，ADR-0009；VTT → proceed/{id}/subtitles/）
//     - /users 等（ADR-0004 功能清单）
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";

const STUB = NextResponse.json(
  {
    error: {
      code: "not_implemented",
      message: "scaffold：路由随 specification 实现（ADR-0004/0008）",
    },
  },
  { status: 501 },
);

async function handle(req: NextRequest): Promise<NextResponse> {
  const session = await auth.api.getSession({ headers: req.headers });
  if (!session) {
    return NextResponse.json(
      { error: { code: "unauthorized", message: "未登录" } },
      { status: 401 },
    );
  }
  void new URL(req.url); // specification：按 path 分发到各业务 handler
  return STUB;
}

export const GET = handle;
export const POST = handle;
export const PUT = handle;
export const PATCH = handle;
export const DELETE = handle;
