// 进程启动自检（Next instrumentation：nodejs 运行时每个服务进程执行一次 register）。
//
// 目的：把 MASTER_KEYS 的问题在**启动日志**里一次说清。「env 里没有」与「值格式非法」
// 必须可区分——否则部署侧明明配了 MK，页面/日志仍只报一句含糊的“未配置”，无从下手。
// 只输出状态与原因，永不打印密钥值（ADR-0006 分层根 / ADR-0015）。
export async function register(): Promise<void> {
  // 仅 nodejs 运行时（edge 编译不加载本逻辑）
  if (process.env.NEXT_RUNTIME === "nodejs") {
    try {
      const { masterKeysDiagnostic, masterKeysSummary } = await import("./lib/master-keys");
      const d = masterKeysDiagnostic();
      if (d.ok) {
        console.log(`[admin] ${masterKeysSummary(d)}`);
        return;
      }
      console.error(`[admin] ${masterKeysSummary(d)}`);
      console.error(
        "[admin] MK 是 ADR-0006 分层根：admin / worker / delivery 三端必须由同一份环境变量提供" +
          "（格式 版本:64位hex，生成 openssl rand -hex 32）；配置后需重启进程。",
      );
    } catch (e) {
      console.error(`[admin] MASTER_KEYS 启动自检未能执行：${(e as Error).message}`);
    }
  }
}
