// ffmpeg 输入通用选项：源片与水印图都经预签名 URL 由 ffmpeg **直接拉取**（字节不落盘），
// 网络读停滞必须有上限，否则单个任务可悬挂到 runFFmpeg 的 6h 兜底超时——而 Worker 串行消费，
// 一个挂死的任务会堵住整个队列（2026-10-17 实测：CDN 卡顿把一个 `-c copy` 任务拖了 10 分钟以上，
// 队列里 9 个任务停摆）。
//
// `-rw_timeout`（微秒）= 网络读操作的上限：正常下载（含慢速）不受影响，真停滞则报错退出，
// 任务走既有的「失败 → lease 过期重派 / attempts 上限」路径，而不是无限期挂着。
export const INPUT_RW_TIMEOUT_US = 60_000_000;

/** 单个输入的 argv 片段：`-rw_timeout <us> -i <url|path>`（须紧随其 `-i` 之前） */
export function inputArgs(url: string): string[] {
  return ["-rw_timeout", String(INPUT_RW_TIMEOUT_US), "-i", url];
}
