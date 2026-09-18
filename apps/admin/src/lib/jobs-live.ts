// 转码任务观察 hub 的进程内单例（SSE 路由与「发起转码」写路径共用；spec.md §2.1）
// 仅服务端使用（装配 real 依赖：listTranscodeJobs → Prisma）；纯逻辑在 ./jobs-stream（可单测）。
import { createJobsHub } from "./jobs-stream";
import { listTranscodeJobs } from "./transcode";

export const jobsHub = createJobsHub({
  fetchJobs: listTranscodeJobs,
  onError: (e) => console.error("[jobs-live] 观察转码任务失败（下一轮重试）:", e),
});
