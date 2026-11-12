// 任务日志环形缓冲（ADR-0017 修订，2026-11-13）：worker / ffmpeg 的每行输出进内存环形尾部，
// 每 flushMs 覆盖写一次 `transcode_jobs.log_tail`（版本号 +1）。
//
// 为什么是「覆盖尾部」而不是追加表：日志是诊断数据、非事实源；追加行会让长任务写爆表，
// 且管理端只需要最近若干 KB。为什么落库而不是推送：Worker 可能部署为异步云函数，
// 无稳定回连地址、无长连接，DB 是唯一共同介质。
export interface JobLogSinkOptions {
  /** 覆盖写尾部，返回新版本号（真实实现 = jobStore.writeLog） */
  write(tail: string): Promise<number>;
  /** flush 间隔（毫秒），默认 2000 */
  flushMs?: number;
  /** 环形尾部字节上限（UTF-8），默认 48KB；超出后从最旧的行开始丢弃 */
  maxBytes?: number;
  /** 调度器（单测注入手动推进） */
  schedule?: (ms: number, fn: () => void) => () => void;
  /** 失败告警（默认 console.warn；写库失败不能影响转码） */
  onError?(e: unknown): void;
}

export interface JobLogSink {
  /** 追加一行（空行忽略）；同步、不阻塞转码 */
  line(text: string): void;
  /** 立即 flush（无变化时跳过），返回是否真的写入 */
  flush(): Promise<boolean>;
  /** 停表 + 最后一次 flush（成功 / 失败 / 取消都调用） */
  stop(): Promise<void>;
  /** 测试观测：当前尾部文本 */
  tail(): string;
  /** 测试观测：当前版本号 */
  seq(): number;
}

export const DEFAULT_LOG_FLUSH_MS = 2_000;
export const DEFAULT_LOG_MAX_BYTES = 48 * 1024;

/** 单行上限：超长行先截断（ffmpeg 的 stderr 统计行偶发无换行堆积），避免一行吃满环形 */
const MAX_LINE_BYTES = 2 * 1024;

/** 按 UTF-8 字节裁剪到 maxBytes（保留尾部；按行边界丢弃，避免劈裂多字节字符） */
function trimToBytes(lines: string[], maxBytes: number): string[] {
  let total = 0;
  const kept: string[] = [];
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    const bytes = Buffer.byteLength(line, "utf8") + 1; // +1 = 连接换行
    if (kept.length > 0 && total + bytes > maxBytes) break;
    kept.push(line);
    total += bytes;
  }
  return kept.reverse();
}

export function createJobLogSink(opts: JobLogSinkOptions): JobLogSink {
  const flushMs = opts.flushMs ?? DEFAULT_LOG_FLUSH_MS;
  const maxBytes = opts.maxBytes ?? DEFAULT_LOG_MAX_BYTES;
  const schedule =
    opts.schedule ??
    ((ms: number, fn: () => void) => {
      const timer = setTimeout(fn, ms);
      timer.unref?.();
      return () => clearTimeout(timer);
    });
  const onError = opts.onError ?? ((e: unknown) => console.warn(`[worker] 日志写入失败：${(e as Error).message}`));

  let lines: string[] = [];
  let bytes = 0;
  let dirty = false;
  let seq = 0;
  /** 已写入库的尾部：无变化时靠它去重，避免空转 UPDATE */
  let persisted = "";
  let cancelTimer: (() => void) | null = null;
  /** 串行化 flush：避免两次写交叉导致旧尾部覆盖新尾部 */
  let chain: Promise<unknown> = Promise.resolve();
  let stopped = false;

  const currentTail = (): string => lines.join("\n");

  function trim(): void {
    if (bytes <= maxBytes) return;
    lines = trimToBytes(lines, maxBytes);
    bytes = lines.reduce((n, l) => n + Buffer.byteLength(l, "utf8") + 1, 0);
  }

  async function doFlush(): Promise<boolean> {
    if (!dirty) return false;
    const tail = currentTail();
    if (tail === persisted) {
      dirty = false;
      return false;
    }
    try {
      seq = await opts.write(tail);
      persisted = tail;
      dirty = false;
      return true;
    } catch (e) {
      // 写失败保持 dirty：下一轮重试（库不可达 / 任务被级联删除）
      onError(e);
      return false;
    }
  }

  function arm(): void {
    if (stopped) return;
    cancelTimer?.();
    cancelTimer = schedule(flushMs, () => {
      cancelTimer = null;
      chain = chain.then(() => doFlush()).finally(arm);
    });
  }

  arm();

  return {
    line(text) {
      if (stopped) return;
      let line = text.replace(/\r$/, "");
      if (!line) return;
      if (Buffer.byteLength(line, "utf8") > MAX_LINE_BYTES) {
        // 按字符切（避免劈裂代理对），再校验字节
        line = [...line].slice(0, MAX_LINE_BYTES).join("");
        while (Buffer.byteLength(line, "utf8") > MAX_LINE_BYTES) line = [...line].slice(0, -1).join("");
      }
      lines.push(line);
      bytes += Buffer.byteLength(line, "utf8") + 1;
      if (bytes > maxBytes) trim();
      dirty = true;
    },
    flush() {
      chain = chain.then(() => doFlush());
      return chain as Promise<boolean>;
    },
    async stop() {
      if (stopped) return;
      stopped = true;
      cancelTimer?.();
      cancelTimer = null;
      trim();
      chain = chain.then(() => doFlush());
      await chain.catch(() => {});
    },
    tail: currentTail,
    seq: () => seq,
  };
}
