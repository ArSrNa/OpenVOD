// invoked（异步云函数）模式的失效任务巡检（ADR-0017 修订，2026-11-13）。
//
// 背景：常驻 / 门铃模式下，租约过期 = 等待 worker 重新认领（崩溃重派，ADR-0008），不能判失败；
// 但 invoked 模式一次触发只跑一条任务，实例被平台掐断 / 触发未送达时没有任何进程会重派——
// 任务会永远停在 QUEUED / ENCODING，用户只能干等。
//
// 因此这里只在 `worker_mode = invoked` 时生效：把「租约过期超过宽限期」或「排队超时未认领」的
// 未终结任务置 FAILED（last_error 说明可重启），用户点「重启」即重新触发一次实例。
//
// 为什么是「读时巡检」而不是常驻定时器：管理端可能不是常驻进程，定时器会持续唤醒
// serverless 数据库；巡检节流 60s，只在有人看任务页（SSE 观察循环）时发生，代价可忽略。
import { ACTIVE_JOB_STATUSES } from "@openvod/contracts";
import { getDb } from "@openvod/db";
import { SETTING_KEYS } from "@openvod/shared";
import { resolvePlain } from "./settings";

/** 巡检节流：SSE 观察循环 1.5s 一轮，实际最多每 60s 扫一次库 */
const SWEEP_INTERVAL_MS = 60_000;
/** 租约过期后再宽限 5 分钟才判失败：容忍 DB 抖动导致的续租延迟，避免误杀仍在跑的任务 */
export const STALE_LEASE_GRACE_MS = 5 * 60_000;
/** 排队超过 10 分钟仍未认领：视为唤醒未生效（通知丢失 / 实例未启动） */
export const STALE_QUEUE_MS = 10 * 60_000;

/** 巡检依赖（默认实现接 Prisma；单测注入假实现，不连库） */
export interface StaleSweepDeps {
  /** 当前 worker 运行模式（DB `worker_mode` > env `WORKER_MODE`） */
  mode(): Promise<string>;
  /** 把满足条件的任务置 FAILED，返回受影响行数 */
  failStale(cutoff: { leaseBefore: Date; queuedBefore: Date; now: Date }): Promise<number>;
}

function defaultDeps(): StaleSweepDeps {
  return {
    mode: () => resolvePlain(SETTING_KEYS.workerMode).catch(() => "resident"),
    failStale: async ({ leaseBefore, queuedBefore, now }) => {
      const db = getDb<any>();
      const res = await db.transcodeJob.updateMany({
        where: {
          status: { in: ACTIVE_JOB_STATUSES },
          cancelRequestedAt: null,
          OR: [
            // 租约过期且超过宽限期（执行中的实例失联）
            { leaseUntil: { lt: leaseBefore } },
            // 一直没人认领（唤醒未送达 / 实例没起来）
            { status: "QUEUED", createdAt: { lt: queuedBefore } },
          ],
        },
        data: {
          status: "FAILED",
          lastError: "异步实例未执行（触发未送达或实例被中断）；任务已超时，可重启重试",
          finishedAt: now,
          leaseUntil: null,
          progress: null,
        },
      });
      return res.count;
    },
  };
}

let lastSweepAt = 0;

/** 立即巡检一次（单测直调）；返回被置失败的任务数 */
export async function sweepStaleJobs(now = Date.now(), deps: StaleSweepDeps = defaultDeps()): Promise<number> {
  if ((await deps.mode()) !== "invoked") return 0; // 常驻 / 门铃：租约过期等待重派，不能判失败
  const count = await deps.failStale({
    leaseBefore: new Date(now - STALE_LEASE_GRACE_MS),
    queuedBefore: new Date(now - STALE_QUEUE_MS),
    now: new Date(now),
  });
  if (count > 0) {
    console.warn(`[job-watchdog] ${count} 个任务超时未执行，已置 FAILED（invoked 模式无重派）`);
  }
  return count;
}

/** 节流版：供任务列表 / SSE 观察循环在读取前调用 */
export async function maybeSweepStaleJobs(now = Date.now()): Promise<number> {
  if (now - lastSweepAt < SWEEP_INTERVAL_MS) return 0;
  lastSweepAt = now;
  return sweepStaleJobs(now).catch((e) => {
    console.warn("[job-watchdog] 巡检失败（下一轮重试）:", (e as Error).message);
    return 0;
  });
}
