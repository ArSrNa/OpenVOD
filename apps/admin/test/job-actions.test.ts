// 转码任务「停止 / 重启」操作守卫单测（spec.md §5.1；ADR-0008）
// 覆盖：排队可停止、执行中（租约有效）拒绝、执行中（租约过期 / worker 失联）可停止并提示中断、
//       失败可重启、DONE 均不可、以及 QUEUED 不算「中断」。
// 被测函数为纯判定（不改库），DB 写入与 CAS 在 lib/transcode.ts。
import { describe, expect, it } from "bun:test";
import { jobActionState } from "../src/lib/job-actions";

describe("jobActionState（停止 / 重启守卫）", () => {
  it("QUEUED：可停止（撤下队列），不可重启，不算中断", () => {
    const s = jobActionState({ status: "QUEUED", leaseActive: false });
    expect(s.canStop).toBe(true);
    expect(s.canRestart).toBe(false);
    expect(s.leaseExpired).toBe(false);
  });

  it("执行中且租约有效：不可停止（会被 worker 覆盖），也不可重启", () => {
    const s = jobActionState({ status: "ENCODING", leaseActive: true });
    expect(s.canStop).toBe(false);
    expect(s.stopBlocked).toContain("租约有效");
    expect(s.canRestart).toBe(false);
    expect(s.leaseExpired).toBe(false);
  });

  it("执行中但租约已过期（worker 失联）：可停止，状态列提示中断", () => {
    for (const status of ["PROBING", "ENCODING", "PACKAGING"]) {
      const s = jobActionState({ status, leaseActive: false });
      expect(s.canStop).toBe(true);
      expect(s.leaseExpired).toBe(true);
      expect(s.canRestart).toBe(false);
    }
  });

  it("FAILED（失败或手动停止）：可重启，不可停止", () => {
    const s = jobActionState({ status: "FAILED", leaseActive: false });
    expect(s.canRestart).toBe(true);
    expect(s.canStop).toBe(false);
    expect(s.stopBlocked).toContain("已结束");
  });

  it("DONE：均不可", () => {
    const s = jobActionState({ status: "DONE", leaseActive: false });
    expect(s.canStop).toBe(false);
    expect(s.canRestart).toBe(false);
    expect(s.restartBlocked).toContain("失败");
  });
});
