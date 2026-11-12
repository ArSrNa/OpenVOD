// admin → worker 门铃通知单测（ADR-0017 §3）：URL / Bearer 装配、失败不抛异常、
// 以及新设置键的写入校验（worker_mode 枚举、worker_notify_secret 长度）。
import { expect, test } from "bun:test";
import { normalizeSettingValue, SettingsError } from "../src/lib/settings";
import { postWorkerWake } from "../src/lib/worker-notify";

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

test("POST {url}/wake 且带 Bearer 密钥；202 视为送达", async () => {
  const { fetchImpl, calls } = fakeFetch(202);
  const result = await postWorkerWake({ url: "https://worker.example.com/", secret: "s3cret", fetchImpl });
  expect(result).toEqual({ notified: true });
  expect(calls).toEqual([{ url: "https://worker.example.com/wake", authorization: "Bearer s3cret", body: null }]);
});

test("带 jobIds 时以 JSON 载荷发送（invoked 模式定向认领）", async () => {
  const { fetchImpl, calls } = fakeFetch(202);
  await postWorkerWake({ url: "https://worker.example.com", secret: "s3cret", jobIds: ["job-a", "job-b"], fetchImpl });
  expect(calls[0]!.body).toBe(JSON.stringify({ job_ids: ["job-a", "job-b"] }));
});

test("非 202 / 网络错误 / 缺配置：不送达但绝不抛异常", async () => {
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
