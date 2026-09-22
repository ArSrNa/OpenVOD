import { getAuth } from "@/lib/auth";

// better-auth 路由入口（ADR-0013）。ADR-0015：auth 实例惰性初始化，
// 首个请求时从 system_settings 解封会话密钥（env 兜底），支持首次启动向导。
async function handler(req: Request): Promise<Response> {
  const auth = await getAuth();
  return auth.handler(req);
}

export { handler as GET, handler as POST };
