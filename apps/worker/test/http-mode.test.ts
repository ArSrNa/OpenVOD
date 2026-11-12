// HTTP 门铃模式单测（ADR-0017 §2）：/wake 鉴权、202 语义、drain 合并、空闲退出。
import { expect, test } from "bun:test";
import { createHttpWorker } from "../src/http-mode";

const SECRET = "0123456789abcdef";

interface Harness {
  worker: ReturnType<typeof createHttpWorker>;
  url: string;
  wakeCount: () => number;
  resolveWake: () => void;
}

/** 起一个真实 HTTP 服务（port: 0 随机），onWake 挂起以便观测并发合并 */
async function start(): Promise<Harness> {
  let count = 0;
  let release = () => {};
  const gate = new Promise<void>((r) => (release = r));
  const worker = createHttpWorker({
    port: 0,
    notifySecret: SECRET,
    onWake: async () => {
      count++;
      await gate;
    },
  });
  await worker.start();
  return { worker, url: `http://127.0.0.1:${worker.port()}`, wakeCount: () => count, resolveWake: release };
}

test("缺少或错误的 Bearer 返回 401，不触发 drain", async () => {
  const h = await start();
  try {
    for (const authorization of [undefined, `Bearer wrong`, `Basic ${SECRET}`] as const) {
      const res = await fetch(`${h.url}/wake`, {
        method: "POST",
        headers: authorization ? { authorization } : {},
      });
      expect(res.status).toBe(401);
    }
    expect(h.wakeCount()).toBe(0);
  } finally {
    await h.worker.stop();
  }
});

test("合法 /wake 立即 202 且异步触发 drain；并发唤醒合并为一轮", async () => {
  const h = await start();
  try {
    const first = await fetch(`${h.url}/wake`, { method: "POST", headers: { authorization: `Bearer ${SECRET}` } });
    expect(first.status).toBe(202);
    await Bun.sleep(10); // 让 onWake 启动（挂起在 gate 上）
    expect(h.worker.isDraining()).toBe(true);

    const second = await fetch(`${h.url}/wake`, { method: "POST", headers: { authorization: `Bearer ${SECRET}` } });
    expect(second.status).toBe(202);
    h.resolveWake();
    await Bun.sleep(10);
    expect(h.wakeCount()).toBe(1); // drain 未结束时再来唤醒不叠加
    expect(h.worker.isDraining()).toBe(false);
  } finally {
    h.resolveWake();
    await h.worker.stop();
  }
});

test("载荷 job_ids 去重后定向传递（invoked 模式），无载荷传空数组", async () => {
  const seen: string[][] = [];
  const worker = createHttpWorker({
    port: 0,
    notifySecret: SECRET,
    onWake: (ids) => {
      seen.push(ids);
    },
  });
  await worker.start();
  try {
    const url = `http://127.0.0.1:${worker.port()}`;
    const res = await fetch(`${url}/wake`, {
      method: "POST",
      headers: { authorization: `Bearer ${SECRET}`, "content-type": "application/json" },
      body: JSON.stringify({ job_ids: ["job-a", "job-a", "job-b"] }),
    });
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({ accepted: true, job_ids: 2 });
    await Bun.sleep(10);
    expect(seen).toEqual([["job-a", "job-b"]]);

    // 非法 JSON / 无 body：按空数组处理（http 模式照常扫队列），不能 500
    const bad = await fetch(`${url}/wake`, {
      method: "POST",
      headers: { authorization: `Bearer ${SECRET}`, "content-type": "application/json" },
      body: "{not-json",
    });
    expect(bad.status).toBe(202);
    await Bun.sleep(10);
    expect(seen.at(-1)).toEqual([]);
  } finally {
    await worker.stop();
  }
});

test("drain 期间到达的 job_ids 不丢：合并到下一轮", async () => {
  const calls: string[][] = [];
  let release = () => {};
  const gate = new Promise<void>((r) => (release = r));
  const worker = createHttpWorker({
    port: 0,
    notifySecret: SECRET,
    onWake: async (ids) => {
      calls.push(ids);
      await gate;
    },
  });
  await worker.start();
  try {
    const url = `http://127.0.0.1:${worker.port()}`;
    const post = (body?: string) =>
      fetch(`${url}/wake`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${SECRET}`,
          ...(body ? { "content-type": "application/json" } : {}),
        },
        ...(body ? { body } : {}),
      });

    await post();
    await Bun.sleep(10);
    expect(worker.isDraining()).toBe(true);
    await post(JSON.stringify({ job_ids: ["late"] })); // drain 未结束
    release();
    await Bun.sleep(20);
    expect(calls).toEqual([[], ["late"]]);
  } finally {
    release();
    await worker.stop();
  }
});

test("healthz 与未知路径", async () => {
  const h = await start();
  try {
    expect((await fetch(`${h.url}/healthz`)).status).toBe(200);
    expect((await fetch(`${h.url}/wake`)).status).toBe(404); // GET /wake 不成立
    expect((await fetch(`${h.url}/nope`)).status).toBe(404);
  } finally {
    await h.worker.stop();
  }
});

test("未配置密钥拒绝启动", async () => {
  const worker = createHttpWorker({ port: 0, notifySecret: "", onWake: () => {} });
  await expect(worker.start()).rejects.toThrow(/WORKER_NOTIFY_SECRET/);
});

test("空闲超时触发 onIdle；有新唤醒则不触发", async () => {
  let now = 1_000_000;
  const scheduled: Array<{ ms: number; fn: () => void }> = [];
  let idleCalls = 0;
  const worker = createHttpWorker({
    port: 0,
    notifySecret: SECRET,
    onWake: () => {},
    idleExitMs: 5 * 60_000,
    onIdle: () => idleCalls++,
    now: () => now,
    schedule: (ms, fn) => {
      scheduled.push({ ms, fn });
      return () => {};
    },
  });

  const fire = (ms: number) => {
    for (const s of scheduled.splice(0)) if (s.ms === ms) s.fn();
  };

  await worker.start();
  expect(scheduled.at(-1)!.ms).toBe(60_000); // 检查周期 = min(idleExitMs, 60s)

  // 未达阈值：重排而不是退出
  now += 30_000;
  fire(60_000);
  expect(idleCalls).toBe(0);
  expect(scheduled.length).toBe(1);

  // 超过阈值：退出
  now += 5 * 60_000;
  fire(60_000);
  expect(idleCalls).toBe(1);
});
