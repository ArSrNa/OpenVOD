// admin → worker 门铃通知单测（ADR-0017 §3）：URL / Bearer 装配、失败不抛异常、
// 以及新设置键的写入校验（worker_mode 枚举、worker_notify_secret 长度）。
import { expect, test } from "bun:test";
import { normalizeSettingValue, SettingsError } from "../src/lib/settings";
import { DETACHED_WAKE_TIMEOUT_MS, DEFAULT_WAKE_TIMEOUT_MS, postWorkerWake } from "../src/lib/worker-notify";

function fakeFetch(status: number): {
  fetchImpl: typeof fetch;
  calls: Array<{ url: string; authorization: string | null; body: string | null }>;
} {
  const calls: Array<{ url: string; authorization: string | null; body: string | null }> = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: String(input),
      authorization: (init?.headers as Record<string, string>)?.authorization ?? null,
      body: typeof init?.body === "string" ? init.body : null,
    });
    return new Response(null, { status });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

test("POST {url}/wake 且带 Bearer 密钥；2xx 视为送达（202 异步受理 / 200 同步完成）", async () => {
  const { fetchImpl, calls } = fakeFetch(202);
  const result = await postWorkerWake({ url: "https://worker.example.com/", secret: "s3cret", fetchImpl });
  expect(result).toEqual({ notified: true });
  expect(calls).toEqual([{ url: "https://worker.example.com/wake", authorization: "Bearer s3cret", body: null }]);

  // WORKER_WAKE_SYNC：worker 等任务跑完才响应 200，同样算送达
  const sync = fakeFetch(200);
  expect((await postWorkerWake({ url: "https://worker.example.com", secret: "s3cret", fetchImpl: sync.fetchImpl })).notified).toBe(true);
});

test("带 jobIds 时以 JSON 载荷发送（invoked 模式定向认领）", async () => {
  const { fetchImpl, calls } = fakeFetch(202);
  await postWorkerWake({ url: "https://worker.example.com", secret: "s3cret", jobIds: ["job-a", "job-b"], fetchImpl });
  expect(calls[0]!.body).toBe(JSON.stringify({ job_ids: ["job-a", "job-b"] }));
});

test("非 2xx / 网络错误 / 缺配置：不送达但绝不抛异常", async () => {
  const { fetchImpl } = fakeFetch(503);
  expect((await postWorkerWake({ url: "https://worker.example.com", secret: "s3cret", fetchImpl })).notified).toBe(false);

  const throwing = (async () => {
    throw new Error("connection refused");
  }) as unknown as typeof fetch;
  const failed = await postWorkerWake({ url: "https://worker.example.com", secret: "s3cret", fetchImpl: throwing });
  expect(failed).toMatchObject({ notified: false, reason: "connection refused" });

  expect((await postWorkerWake({ url: "", secret: "s3cret", fetchImpl })).notified).toBe(false);
  expect((await postWorkerWake({ url: "https://worker.example.com", secret: "", fetchImpl })).reason).toContain("worker_notify_secret");
});

test("唤醒外呼有等待上限：不可达地址按未送达返回，不拖住调用方", async () => {
  // 只接 abort、永不 resolve 的 fetch：验证 timeoutMs 到点即返回失败而不是挂死
  const hanging = ((_input: RequestInfo | URL, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
    })) as typeof fetch;
  const result = await postWorkerWake({
    url: "https://worker.example.com",
    secret: "s3cret",
    fetchImpl: hanging,
    timeoutMs: 10,
  });
  expect(result.notified).toBe(false);
});

test("响应后发送的等待上限覆盖整条转码链（不得退回响应前那 5s）", () => {
  // 同步唤醒（WORKER_WAKE_SYNC）下 /wake 要等任务跑完才响应；响应后发送若仍用 5s，
  // 等于把 ADR-0017 §8 的 499 从「切断响应」平移到「切断后台外呼」
  expect(DETACHED_WAKE_TIMEOUT_MS).toBeGreaterThanOrEqual(30 * 60_000);
  expect(DETACHED_WAKE_TIMEOUT_MS).toBeGreaterThan(DEFAULT_WAKE_TIMEOUT_MS);
});

test("worker_mode 仅允许 resident / http / invoked", () => {
  expect(normalizeSettingValue("worker_mode", "http")).toBe("http");
  expect(normalizeSettingValue("worker_mode", "Resident")).toBe("resident");
  expect(normalizeSettingValue("worker_mode", "Invoked")).toBe("invoked");
  expect(() => normalizeSettingValue("worker_mode", "websocket")).toThrow(SettingsError);
});

test("worker_notify_url 必须是合法 http(s) URL", () => {
  expect(normalizeSettingValue("worker_notify_url", "https://worker.example.com/")).toBe("https://worker.example.com");
  expect(() => normalizeSettingValue("worker_notify_url", "ftp://x")).toThrow(SettingsError);
  expect(() => normalizeSettingValue("worker_notify_url", "https://user@worker.example.com")).toThrow(SettingsError);
});

test("worker_notify_secret 至少 16 字符（MK 封装键，写入侧校验）", () => {
  expect(normalizeSettingValue("worker_notify_secret", "0123456789abcdef")).toBe("0123456789abcdef");
  expect(() => normalizeSettingValue("worker_notify_secret", "short")).toThrow(SettingsError);
});
