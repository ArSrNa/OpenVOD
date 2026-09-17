// 受保护的控制台业务 API（ADR-0010 端点语义平移到 /api/admin/*）
// scaffold：统一会话守卫 + 501 占位；具体路由随 specification 实现。
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
