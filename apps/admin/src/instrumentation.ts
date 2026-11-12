// 进程启动自检（Next instrumentation：nodejs 运行时每个服务进程执行一次 register）。
//
// 目的：把 MASTER_KEYS 与 ffprobe 的问题在**启动日志**里一次说清。
// - 「env 里没有」与「值格式非法」必须可区分——否则部署侧明明配了 MK，页面/日志仍只报一句含糊的“未配置”，
//   无从下手。只输出状态与原因，永不打印密钥值（ADR-0006 分层根 / ADR-0015）。
// - ffprobe 缺失只影响「生成元数据」与「水印图片宽高」两条功能（spec.md §2.1 / §10.2），
//   属**告警不阻断**：文件上传、转码发起、播放预览都不依赖它，启动即失败反而误伤主线。
export async function register(): Promise<void> {
  // 仅 nodejs 运行时（edge 编译不加载本逻辑）
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  try {
    const { masterKeysDiagnostic, masterKeysSummary } = await import("./lib/master-keys");
    const d = masterKeysDiagnostic();
    if (d.ok) {
      console.log(`[admin] ${masterKeysSummary(d)}`);
    } else {
      console.error(`[admin] ${masterKeysSummary(d)}`);
      console.error(
        "[admin] MK 是 ADR-0006 分层根：admin / worker / delivery 三端必须由同一份环境变量提供" +
          "（格式 版本:64位hex，生成 openssl rand -hex 32）；配置后需重启进程。",
      );
    }
  } catch (e) {
    console.error(`[admin] MASTER_KEYS 启动自检未能执行：${(e as Error).message}`);
  }

  try {
    const { FFPROBE_HINT, probeFFprobeAvailability } = await import("./lib/ffprobe-env");
    const reason = await probeFFprobeAvailability();
    if (reason) {
      console.warn(`[admin] ${reason}——「生成元数据」与「水印图片上传」将返回 500；${FFPROBE_HINT}`);
    } else {
      console.log("[admin] ffprobe 自检通过");
    }
  } catch (e) {
    console.error(`[admin] ffprobe 启动自检未能执行：${(e as Error).message}`);
  }
}
