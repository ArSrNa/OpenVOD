// 控制台页面公共守卫（服务端组件用）：
// 会话校验（重定向 /login）+ 首次启动向导门禁（重定向 /setup，ADR-0015）。
// 各 page.tsx 只调 requireConsoleSession()，不再各自引 auth / headers / redirect。
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getAuth, type AuthInstance } from "./auth";
import { isSetupCompleted } from "./settings";

export type ConsoleSession = NonNullable<
  Awaited<ReturnType<AuthInstance["api"]["getSession"]>>
>;

export async function requireConsoleSession(): Promise<ConsoleSession> {
  // 先判向导（未初始化时连登录页都进不去——还没有管理员账号），再判会话
  if (!(await isSetupCompleted().catch(() => true))) redirect("/setup");
  const auth = await getAuth();
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) redirect("/login");
  return session;
}
