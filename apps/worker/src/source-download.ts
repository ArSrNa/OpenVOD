// 源片拉取（2026-10-17，spec.md §5.1「拉取源片」阶段）：把源片从取源通路下载到任务临时目录。
//
// 为什么把「拉取」独立成阶段（而不是让 ffmpeg 边流边转）：
//  ① 状态可区分——拉取受网络支配、转码受 CPU 支配，混在一起看谁都说不清任务卡在哪；
//  ② 多档复用——ladder 有多档时只下载一次（此前每档 ffmpeg 各自从网络重读一遍源片）；
//  ③ 转码输入本地文件，不再受网络抖动影响；下载阶段可上报进度（transcode_jobs.progress）。
// 输入本身是本地路径时（单测 / 未来的本地暂存）直接复用，不复制。
import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

export interface FetchSourceOptions {
  url: string;
  /** 落地路径（任务临时目录内；随任务结束一并清理） */
  destPath: string;
  /** 预期总字节数（storage.stat 得来）；用于进度与完整性校验，未知传 null */
  totalBytes?: number | null;
  onProgress?: (downloaded: number, total: number | null) => void;
  /** 读停滞上限（毫秒）：这么久没有任何数据即失败（与 ffmpeg 输入的 -rw_timeout 同口径） */
  idleTimeoutMs?: number;
  /** 外部中断（管理端取消任务）：abort 即断开连接并删除半成品（由任务目录整体清理） */
  signal?: AbortSignal;
}

export interface FetchSourceResult {
  /** ffprobe / ffmpeg 的输入：本地文件路径（远端来源已落盘；本地来源原样返回） */
  input: string;
  bytes: number;
  downloaded: boolean;
}

const DEFAULT_IDLE_TIMEOUT_MS = 60_000;

const isRemote = (url: string) => /^https?:\/\//i.test(url);

export async function fetchSourceToLocal(opts: FetchSourceOptions): Promise<FetchSourceResult> {
  const idleTimeoutMs = opts.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  if (!isRemote(opts.url)) return { input: opts.url, bytes: 0, downloaded: false };

  await mkdir(dirname(opts.destPath), { recursive: true });
  const controller = new AbortController();
  let idle: ReturnType<typeof setTimeout> | undefined;
  let idleFired = false;
  let cancelled = false;
  const arm = () => {
    clearTimeout(idle);
    idle = setTimeout(() => {
      idleFired = true;
      controller.abort();
    }, idleTimeoutMs);
  };
  arm();

  // 外部取消与「读停滞」共用同一个 AbortController，但报错措辞要能区分（前者是用户意图，后者是故障）
  const onCancel = () => {
    cancelled = true;
    controller.abort();
  };
  if (opts.signal?.aborted) onCancel();
  else opts.signal?.addEventListener("abort", onCancel, { once: true });

  try {
    const res = await fetch(opts.url, { signal: controller.signal });
    if (!res.ok) throw new Error(`拉取源片失败：HTTP ${res.status}`);
    if (!res.body) throw new Error("拉取源片失败：响应无内容体");

    const headerLen = Number(res.headers.get("content-length"));
    const total = opts.totalBytes ?? (Number.isFinite(headerLen) && headerLen > 0 ? headerLen : null);
    let received = 0;
    const meter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        received += chunk.length;
        arm();
        opts.onProgress?.(received, total);
        callback(null, chunk);
      },
    });
    await pipeline(
      Readable.fromWeb(res.body as unknown as import("node:stream/web").ReadableStream),
      meter,
      createWriteStream(opts.destPath),
      { signal: controller.signal },
    );
    if (total != null && received !== total) {
      throw new Error(`拉取源片不完整：${received}/${total} 字节`);
    }
    return { input: opts.destPath, bytes: received, downloaded: true };
  } catch (e) {
    // 中止原因：取消请求优先，其次停滞（底层 abort 的报错措辞随运行时版本而异）
    if (cancelled) throw new Error("任务已取消（已中止拉取源片）");
    if (idleFired) throw new Error(`拉取源片停滞超过 ${idleTimeoutMs}ms（已中止）`);
    throw e;
  } finally {
    clearTimeout(idle);
    opts.signal?.removeEventListener("abort", onCancel);
  }
}
