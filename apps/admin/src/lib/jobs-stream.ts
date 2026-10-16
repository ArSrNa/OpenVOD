// 转码任务实时观察 hub（SSE 数据侧；spec.md §2.1 / §3.1）
// 为什么服务端要「观察 DB」而不是 Worker 主动通知：Worker 是独立进程（ADR-0011），
// MySQL / SQLite 没有 LISTEN/NOTIFY 这类跨进程通知，管理端唯一可用的变化来源就是自己的库。
// 因此把观察关在服务端：同一进程内所有 SSE 连接共享一个观察循环（订阅者归零即停机），
// 且**只在快照真正变化时**广播全量 —— 浏览器侧零轮询，仅在变化时收到一帧。
// 本文件保持纯逻辑（无 DB / 无副作用，调度器可注入），单测见 apps/admin/test/jobs-stream.test.ts。

import { ACTIVE_JOB_STATUSES } from "@openvod/contracts";

/** 未终结状态（唯一真相源在 @openvod/contracts）：存在即按「活跃间隔」观察 */
const ACTIVE_STATUSES = new Set<string>(ACTIVE_JOB_STATUSES);

/** 有未终结任务时的观察间隔：任务在跑，状态迁移较密 */
const DEFAULT_ACTIVE_INTERVAL_MS = 1500;
/** 全部终结时的观察间隔：通常只在别的标签页发起新任务时才有变化 */
const DEFAULT_IDLE_INTERVAL_MS = 5000;

export interface JobsSnapshot<T extends { status: string }> {
  total: number;
  items: T[];
}

export interface JobsHubOptions<T extends { status: string }> {
  /** 读一次任务列表（真实装配 = lib/transcode 的 listTranscodeJobs） */
  fetchJobs(): Promise<JobsSnapshot<T>>;
  activeIntervalMs?: number;
  idleIntervalMs?: number;
  /** 调度器（默认 setTimeout；单测注入手动推进，不依赖真实计时） */
  schedule?: (ms: number, fn: () => void) => () => void;
  onError?(e: unknown): void;
}

export interface JobsHub<T extends { status: string }> {
  /** 订阅快照：已有缓存立即回放，否则立即观察一轮；返回退订函数（订阅者归零 → 观察停机） */
  subscribe(listener: (snapshot: JobsSnapshot<T>) => void): () => void;
  /** 已知有写入（如管理端刚发起任务）时立刻观察一轮，不等下一个间隔 */
  poke(): void;
}

/** 变化指纹：任务列表字段少且稳定（不含 lease 心跳字段），整体串化即可 */
function fingerprint(items: Array<{ status: string }>): string {
  return JSON.stringify(items);
}

export function createJobsHub<T extends { status: string }>(options: JobsHubOptions<T>): JobsHub<T> {
  const schedule =
    options.schedule ??
    ((ms: number, fn: () => void) => {
      const timer = setTimeout(fn, ms);
      return () => clearTimeout(timer);
    });
  const activeMs = options.activeIntervalMs ?? DEFAULT_ACTIVE_INTERVAL_MS;
  const idleMs = options.idleIntervalMs ?? DEFAULT_IDLE_INTERVAL_MS;

  const listeners = new Set<(snapshot: JobsSnapshot<T>) => void>();
  let latest: JobsSnapshot<T> | null = null;
  let lastFingerprint: string | null = null;
  let cancelWait: (() => void) | null = null;
  let observing = false;

  function nextInterval(): number {
    return latest && latest.items.some((i) => ACTIVE_STATUSES.has(i.status)) ? activeMs : idleMs;
  }

  /** 观察一轮：有变化才广播；失败上报后照常续排（不打断循环） */
  async function observeOnce(): Promise<void> {
    observing = true;
    try {
      let next: JobsSnapshot<T>;
      try {
        next = await options.fetchJobs();
      } catch (e) {
        options.onError?.(e);
        return;
      }
      latest = next;
      const fp = fingerprint(next.items);
      if (fp === lastFingerprint) return;
      lastFingerprint = fp;
      for (const listener of [...listeners]) listener(next);
    } finally {
      observing = false;
    }
  }

  /** 排下一轮（重排先取消旧排程） */
  function arm(ms: number): void {
    cancelWait?.();
    cancelWait = schedule(ms, observeThenArm);
  }

  /** 立即观察一轮，完成后按最新活跃度续排；在途观察不重复发起（其完成自会续排） */
  function observeThenArm(): void {
    cancelWait?.();
    cancelWait = null;
    if (observing) return;
    void observeOnce().then(() => {
      if (listeners.size && !cancelWait) arm(nextInterval());
    });
  }

  return {
    subscribe(listener) {
      listeners.add(listener);
      if (latest) listener(latest); // 新连接先回放缓存快照，不必等下一轮
      if (!cancelWait && !observing) observeThenArm(); // 冷启动：立即观察，首帧尽快送达
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) {
          cancelWait?.();
          cancelWait = null; // 无人订阅 → 停机，不产生空转查询
        }
      };
    },
    poke() {
      if (listeners.size) observeThenArm();
    },
  };
}
