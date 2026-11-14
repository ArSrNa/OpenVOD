// 转码任务「取消 / 重启」操作守卫单测（spec.md §5.1；ADR-0008）
// 覆盖：排队可取消、执行中可提交取消请求（立即打断）、取消请求等待中拒绝重复提交、
//       租约过期（worker 失联）可收尾并提示中断、失败 / 已取消可重启、DONE 均不可。
// 被测函数为纯判定（不改库），DB 写入与 CAS 在 lib/transcode.ts。
import { describe, expect, it } from "bun:test";
import { jobActionState, partitionDeletableJobs } from "../src/lib/job-actions";

describe("jobActionState（取消 / 重启守卫）", () => {
  it("QUEUED：可取消（撤下队列），不可重启，不算中断", () => {
    const s = jobActionState({ status: "QUEUED", leaseActive: false });
    expect(s.canStop).toBe(true);
    expect(s.canRestart).toBe(false);
    expect(s.leaseExpired).toBe(false);
    expect(s.cancelling).toBe(false);
  });

  it("执行中且租约有效：可取消——提交取消请求后由 worker 立即中断", () => {
    const s = jobActionState({ status: "ENCODING", leaseActive: true });
    expect(s.canStop).toBe(true);
    expect(s.cancelling).toBe(false);
    expect(s.canRestart).toBe(false);
  });

  it("取消请求已提交且租约仍有效：拒绝重复提交，状态列显示「取消中」", () => {
    const s = jobActionState({ status: "ENCODING", leaseActive: true, cancelRequested: true });
    expect(s.canStop).toBe(false);
    expect(s.cancelling).toBe(true);
    expect(s.stopBlocked).toContain("等待 worker");
    expect(s.canRestart).toBe(false);
  });

  it("执行中但租约已过期（worker 失联）：可取消收尾，状态列提示中断", () => {
    for (const status of ["PROBING", "DOWNLOADING", "ENCODING", "PACKAGING"]) {
      const s = jobActionState({ status, leaseActive: false });
      expect(s.canStop).toBe(true);
      expect(s.leaseExpired).toBe(true);
      expect(s.canRestart).toBe(false);
    }
  });

  it("取消请求已提交但 worker 失联：仍可再次提交以立即收尾", () => {
    const s = jobActionState({ status: "ENCODING", leaseActive: false, cancelRequested: true });
    expect(s.canStop).toBe(true);
    expect(s.cancelling).toBe(true);
    expect(s.leaseExpired).toBe(true);
  });

  it("FAILED / CANCELLED：可重启，不可取消", () => {
    for (const status of ["FAILED", "CANCELLED"]) {
      const s = jobActionState({ status, leaseActive: false });
      expect(s.canRestart).toBe(true);
      expect(s.canStop).toBe(false);
      expect(s.stopBlocked).toContain("已结束");
    }
  });

  it("DONE：均不可", () => {
    const s = jobActionState({ status: "DONE", leaseActive: false });
    expect(s.canStop).toBe(false);
    expect(s.canRestart).toBe(false);
    expect(s.restartBlocked).toContain("失败或已取消");
  });
});

describe("partitionDeletableJobs（批量删除划分）", () => {
  const rows = [
    { id: "done", status: "DONE" },
    { id: "failed", status: "FAILED" },
    { id: "cancelled", status: "CANCELLED" },
    { id: "queued", status: "QUEUED" },
    { id: "encoding", status: "ENCODING" },
  ];

  it("终结态可删，进行中的一律跳过", () => {
    const r = partitionDeletableJobs(["done", "failed", "cancelled", "queued", "encoding"], rows);
    expect(r.deletable).toEqual(["done", "failed", "cancelled"]);
    expect(r.skipped.map((s) => s.id)).toEqual(["queued", "encoding"]);
    expect(r.skipped[0]!.reason).toContain("进行中");
  });

  it("不存在的 id 跳过并说明原因（并发删除 / 过期列表）", () => {
    const r = partitionDeletableJobs(["done", "gone"], rows);
    expect(r.deletable).toEqual(["done"]);
    expect(r.skipped).toEqual([{ id: "gone", reason: "任务不存在" }]);
  });

  it("重复 id 去重，保持首次出现的顺序", () => {
    const r = partitionDeletableJobs(["failed", "done", "failed"], rows);
    expect(r.deletable).toEqual(["failed", "done"]);
    expect(r.skipped).toEqual([]);
  });
});
