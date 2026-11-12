// 失效任务巡检单测（ADR-0017 §6）：只在 invoked 模式生效，阈值与时间戳正确传递。
import { describe, expect, test } from "bun:test";
import { STALE_LEASE_GRACE_MS, STALE_QUEUE_MS, sweepStaleJobs } from "../src/lib/job-watchdog";

const NOW = 1_800_000_000_000;

function harness(mode: string, count = 0) {
  const calls: Array<{ leaseBefore: Date; queuedBefore: Date; now: Date }> = [];
  return {
    calls,
    deps: {
      mode: async () => mode,
      failStale: async (cutoff: { leaseBefore: Date; queuedBefore: Date; now: Date }) => {
        calls.push(cutoff);
        return count;
      },
    },
  };
}

describe("sweepStaleJobs", () => {
  test("resident / http 模式不巡检（租约过期等待重派）", async () => {
    for (const mode of ["resident", "http"]) {
      const h = harness(mode);
      expect(await sweepStaleJobs(NOW, h.deps)).toBe(0);
      expect(h.calls).toEqual([]);
    }
  });

  test("invoked 模式按宽限期计算阈值并返回受影响行数", async () => {
    const h = harness("invoked", 2);
    expect(await sweepStaleJobs(NOW, h.deps)).toBe(2);
    expect(h.calls).toHaveLength(1);
    const cutoff = h.calls[0]!;
    expect(cutoff.now.getTime()).toBe(NOW);
    expect(cutoff.leaseBefore.getTime()).toBe(NOW - STALE_LEASE_GRACE_MS);
    expect(cutoff.queuedBefore.getTime()).toBe(NOW - STALE_QUEUE_MS);
  });

  test("模式未配置（空串）按非 invoked 处理，不误杀", async () => {
    const h = harness("");
    expect(await sweepStaleJobs(NOW, h.deps)).toBe(0);
    expect(h.calls).toEqual([]);
  });
});
