// 转码任务实时观察 hub 单测（SSE 数据侧；spec.md §2.1）
// 覆盖：订阅即观察并回放快照、相同快照不重复推送、变化推送全量、新订阅者回放缓存、退订归零停机、
//       poke 立即重查、观察间隔随活跃任务自适应、拉取失败不打断循环。
// 调度器注入手动推进（不依赖真实计时）；hub 为纯逻辑，不连 DB / 不写文件。
import { describe, expect, it } from "bun:test";
import { createJobsHub, type JobsSnapshot } from "../src/lib/jobs-stream";

interface Item {
  id: string;
  status: string;
}

/** 手动调度器：收集待执行排程，测试按需推进并断言间隔 */
function makeScheduler() {
  const pending: Array<{ ms: number; run: () => void }> = [];
  return {
    /** 注入 hub 的调度函数 */
    schedule(ms: number, fn: () => void): () => void {
      const entry = { ms, run: fn };
      pending.push(entry);
      return () => {
        const i = pending.indexOf(entry);
        if (i >= 0) pending.splice(i, 1);
      };
    },
    /** 待执行排程的间隔（按入队顺序） */
    delays(): number[] {
      return pending.map((p) => p.ms);
    },
    size(): number {
      return pending.length;
    },
    /** 推进最早的一个排程，并等待其异步观察完成 */
    async runNext(): Promise<void> {
      const entry = pending.shift();
      if (!entry) throw new Error("没有待执行的排程");
      entry.run();
      await flush();
    },
  };
}

/** 冲刷微任务：hub 内部是「排程 → 异步拉取 → 再排程」链 */
async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

function makeWorld(initial: Item[]) {
  let items = initial;
  let calls = 0;
  const errors: unknown[] = [];
  const sched = makeScheduler();
  const hub = createJobsHub<Item>({
    fetchJobs: async () => {
      calls += 1;
      return { total: items.length, items: items.map((i) => ({ ...i })) };
    },
    activeIntervalMs: 1500,
    idleIntervalMs: 5000,
    schedule: sched.schedule,
    onError: (e) => errors.push(e),
  });
  return {
    hub,
    sched,
    errors,
    setItems: (next: Item[]) => {
      items = next;
    },
    get calls() {
      return calls;
    },
  };
}

describe("createJobsHub", () => {
  it("订阅立即观察；多订阅者共享同一观察循环", async () => {
    const w = makeWorld([{ id: "j1", status: "DONE" }]);
    const seen: Array<JobsSnapshot<Item>> = [];
    const un1 = w.hub.subscribe((s) => seen.push(s));
    const un2 = w.hub.subscribe((s) => seen.push(s));
    await flush();

    expect(w.calls).toBe(1); // 两个订阅者只触发一次拉取
    expect(seen).toHaveLength(2); // 首轮观察广播给全部订阅者
    expect(seen[0].items.map((i) => i.id)).toEqual(["j1"]);
    expect(w.sched.delays()).toEqual([5000]); // 无活跃任务 → 空闲间隔
    un1();
    un2();
  });

  it("相同快照不重复推送；变化时推送全量", async () => {
    const w = makeWorld([{ id: "j1", status: "QUEUED" }]);
    const seen: Array<JobsSnapshot<Item>> = [];
    const un = w.hub.subscribe((s) => seen.push(s));
    await flush();
    expect(seen).toHaveLength(1);
    expect(w.sched.delays()).toEqual([1500]); // 有 QUEUED → 活跃间隔

    await w.sched.runNext(); // 数据未变
    expect(w.calls).toBe(2);
    expect(seen).toHaveLength(1);

    w.setItems([{ id: "j1", status: "ENCODING" }]);
    await w.sched.runNext(); // 数据变化
    expect(seen).toHaveLength(2);
    expect(seen[1].items[0].status).toBe("ENCODING");
    un();
  });

  it("新订阅者立即回放缓存快照，且不额外拉取", async () => {
    const w = makeWorld([{ id: "j1", status: "DONE" }]);
    const un1 = w.hub.subscribe(() => {});
    await flush();

    const late: Item[] = [];
    const un2 = w.hub.subscribe((s) => late.push(...s.items));
    expect(late.map((i) => i.id)).toEqual(["j1"]); // 同步回放缓存
    expect(w.calls).toBe(1); // 未触发第二次拉取
    un1();
    un2();
  });

  it("全部退订即停机；重新订阅恢复观察", async () => {
    const w = makeWorld([{ id: "j1", status: "DONE" }]);
    const un = w.hub.subscribe(() => {});
    await flush();
    expect(w.calls).toBe(1);
    expect(w.sched.size()).toBe(1);

    un();
    expect(w.sched.size()).toBe(0); // 排程已取消，不空转查询

    let resumed = 0;
    const un2 = w.hub.subscribe(() => (resumed += 1));
    await flush();
    expect(w.calls).toBe(2); // 重启后立即观察
    expect(resumed).toBe(1);
    un2();
  });

  it("poke 取消原排程并立即重查", async () => {
    const w = makeWorld([{ id: "j1", status: "DONE" }]);
    w.hub.subscribe(() => {});
    await flush();
    expect(w.calls).toBe(1);
    expect(w.sched.delays()).toEqual([5000]);

    w.hub.poke();
    await flush();
    expect(w.calls).toBe(2); // 立即重查，不必推进 5s 排程
    expect(w.sched.delays()).toEqual([5000]); // 旧排程已取消，仅剩新排程
  });

  it("无订阅者时 poke 不产生观察", async () => {
    const w = makeWorld([{ id: "j1", status: "DONE" }]);
    w.hub.poke();
    await flush();
    expect(w.calls).toBe(0);
    expect(w.sched.size()).toBe(0);
  });

  it("全部任务终结后切回空闲间隔", async () => {
    const w = makeWorld([{ id: "j1", status: "PACKAGING" }]);
    const un = w.hub.subscribe(() => {});
    await flush();
    expect(w.sched.delays()).toEqual([1500]);

    w.setItems([{ id: "j1", status: "DONE" }]);
    await w.sched.runNext();
    expect(w.sched.delays()).toEqual([5000]);
    un();
  });

  it("拉取失败不打断循环：上报 onError 并继续排程", async () => {
    let failNext = false;
    let calls = 0;
    const errors: unknown[] = [];
    const sched = makeScheduler();
    const hub = createJobsHub<Item>({
      fetchJobs: async () => {
        calls += 1;
        if (failNext) throw new Error("db down");
        return { total: 0, items: [] };
      },
      idleIntervalMs: 5000,
      schedule: sched.schedule,
      onError: (e) => errors.push(e),
    });
    hub.subscribe(() => {});
    await flush();
    expect(calls).toBe(1);

    failNext = true;
    await sched.runNext();
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(Error);
    expect(sched.size()).toBe(1); // 循环仍在，下一轮重试
  });
});
