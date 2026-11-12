// ffprobe 运行环境自检（spec.md §2.1「生成元数据」/ §10.2 水印图片宽高）。
//
// 管理端在**自身进程内**就地执行 ffprobe（源片走 S3 预签名 URL 流，字节不经函数 / 内存），
// 所以「装了没装 ffmpeg」是运行期事实，不是构建期常量：开发容器由 .ide/Dockerfile 提供，
// 容器化部署由 apps/admin/Dockerfile 的 runtime 阶段提供。
//
// 为什么要单独一个模块：旧实现把所有异常吞成一句「运行环境缺少 ffprobe」，而真实原因至少三种，
// 处置完全不同——
//   ENOENT                → 真没装（镜像漏装 / 精简镜像）；
//   GLIBCXX / libav* 报错 → 系统库被 LD_LIBRARY_PATH 遮蔽（CodeBuddy 终端注入自带旧 libstdc++）；
//   超时 / SIGTERM        → 进程被挂起或资源受限。
// 三者都报「缺少 ffprobe」会白排查一轮（2026-11-13 实报）。本模块只做「可用性 + 原因」，
// 不依赖 DB / Prisma / 存储，可被 instrumentation 启动自检与业务逻辑共用。
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

/** 安装提示统一口径（各调用点不要各写一份） */
export const FFPROBE_HINT =
  "需安装 ffmpeg / ffprobe（开发容器见 .ide/Dockerfile，管理端镜像见 apps/admin/Dockerfile）";

/** 执行 `ffprobe -version` 的注入点（单测替身用；真实实现走 child_process） */
export type FFprobeRunner = () => Promise<unknown>;

const runReal: FFprobeRunner = () => execFileP("ffprobe", ["-version"], { timeout: 10_000 });

/**
 * 自检 ffprobe：可用返回 `null`，不可用返回**单行原因**（由调用方拼进自己的错误类型，保持 500 / 400 语义各归各）。
 * 只跑 `-version`：不触网、不读媒体文件，开销可忽略。
 */
export async function probeFFprobeAvailability(run: FFprobeRunner = runReal): Promise<string | null> {
  try {
    await run();
    return null;
  } catch (e) {
    return describeFFprobeFailure(e);
  }
}

/** 把 child_process 的失败压成单行原因（stderr 可能多行且很长，只留尾 200 字符） */
export function describeFFprobeFailure(e: unknown): string {
  const err = e as { code?: string | number; message?: string; stderr?: string; signal?: string; killed?: boolean };
  if (err?.code === "ENOENT") return "未找到 ffprobe 可执行文件（PATH 上没有 ffmpeg）";
  if (err?.killed || err?.signal) return `ffprobe 无响应（被信号 ${err.signal ?? "timeout"} 终止）`;
  const detail = (err?.stderr ?? "").trim() || (err?.message ?? "").trim();
  const tail = detail.replace(/\s+/g, " ").slice(-200);
  return tail ? `ffprobe 执行失败：${tail}` : `ffprobe 执行失败（code=${err?.code ?? "unknown"}）`;
}
