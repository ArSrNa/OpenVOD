import { requireConsoleSession } from "@/lib/console";
import { ConsoleShell } from "@/components/ConsoleShell";
import { cravatarAvatarUrl } from "@/lib/avatar";
import { APP_VERSION } from "@/lib/version";

// 显式声明动态渲染，不依赖推断：守卫读 headers() + DB，Next 虽能从动态 API 推出整条路由
// 动态，但那是实现细节；将来若开 PPR / cacheComponents，缺声明会被固化成静态壳层。
export const dynamic = "force-dynamic";

// 控制台壳层在此挂**一次**（替代原来 17 个页面各自套一层 + 传 props 的写法）。
//
// 路由组 `(console)` 不产生 URL 片段，只把「需要壳层」的页面圈进来：
// /login、/setup、/healthz、/api/** 留在组外，不会被套上侧边栏。
//
// 为什么守卫也放这里：`requireConsoleSession()` 原本每页各调一次（每次跳页两次 DB 读：
// isSetupCompleted + getSession，且 OIDC discovery 落在这条路径上，见 dev-workflow §8 的
// 60s 卡死条目）。收拢到 layout 后每次硬加载只查一次。
// 代价：Next 不在兄弟页面间重跑 layout，故会话过期后**页内跳转**不再自动弹回 /login，
// 需整页刷新才重新守卫——数据侧无越权，35 个 /api/admin/* 各自独立走
// `getAdminSession()`（src/lib/api.ts），过期会话照样 401。
//
// 附带修掉两个壳层问题：ConsoleShell 的 `mounted` 门禁原先每页重挂 → 每次跳页闪一帧
// <Spin/>；转码任务角标的 SSE 与上传完成提示原先切页即断，现在随壳层跨页存活。
export default async function ConsoleLayout({ children }: { children: React.ReactNode }) {
  const session = await requireConsoleSession();
  return (
    // 头像走 Cravatar：MD5 在服务端算（浏览器无 md5），结果以 prop 下传（lib/avatar.ts）
    <ConsoleShell
      userName={session.user.name}
      avatarUrl={cravatarAvatarUrl(session.user.email)}
      version={APP_VERSION}
    >
      {children}
    </ConsoleShell>
  );
}
