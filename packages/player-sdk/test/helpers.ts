// 测试基建：注入 fetch stub（记录调用）+ 响应构造 + 假 token URL（spec §12.1：无真实网络、无真实 delivery）
import { DeliveryError, PlayerSdkError, type FetchLike } from "../src";

/**
 * 捕获 promise 的拒绝值并断言为分发端错误（断言 code / status / message / hint 前的类型收窄）。
 * 未拒绝或错误类型不符 → 抛出原始值，让用例明确失败。
 */
export async function rejection(promise: Promise<unknown>): Promise<DeliveryError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof DeliveryError) return error;
    throw error;
  }
  throw new Error("期望 promise 被拒绝，但它成功返回了");
}

/** 同 rejection，但允许 SDK 自身错误（如 sdk_no_credential / sdk_disposed） */
export async function sdkError(promise: Promise<unknown>): Promise<DeliveryError | PlayerSdkError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof DeliveryError || error instanceof PlayerSdkError) return error;
    throw error;
  }
  throw new Error("期望 promise 被拒绝，但它成功返回了");
}

export interface RecordedCall {
  url: string;
  /** 路径 + query（便于按端点断言） */
  path: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
  signal?: AbortSignal;
}

export type StubHandler = (call: RecordedCall) => Response | Promise<Response>;

export interface FetchStub {
  fetch: FetchLike;
  calls: RecordedCall[];
  /** 按路径谓词统计调用次数 */
  count(predicate: (call: RecordedCall) => boolean): number;
}

export function createFetchStub(handler: StubHandler): FetchStub {
  const calls: RecordedCall[] = [];
  const fetchImpl: FetchLike = async (input, init) => {
    let path = String(input);
    if (/^https?:\/\//i.test(path)) {
      const parsed = new URL(path);
      path = parsed.pathname + parsed.search;
    }
    const call: RecordedCall = {
      url: String(input),
      path,
      method: init?.method ?? "GET",
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      signal: init?.signal ?? undefined,
    };
    calls.push(call);
    return handler(call);
  };
  return {
    fetch: fetchImpl,
    calls,
    count: (predicate) => calls.filter(predicate).length,
  };
}

export function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export function errorResponse(status: number, code: string, message: string): Response {
  return jsonResponse(status, { error: { code, message } });
}

export function textResponse(status: number, body: string): Response {
  return new Response(body, { status, headers: { "content-type": "text/vtt; charset=utf-8" } });
}

export const LOGIN_BODY = {
  access_token: "jwt-token-1",
  token_type: "Bearer" as const,
  expires_in: 3600,
  kid: "urlsign-v1",
};

export function isoFromSec(seconds: number): string {
  return new Date(seconds * 1000).toISOString();
}

/** 构造与分发端同形的签名 URL（query `t` = base64url(JSON payload) + "." + 假签名；exp 供续签调度解析） */
export function signedUrl(exp: number, path = "/v1/media/55395830/manifest/master.m3u8"): string {
  const payload = { ver: 1, typ: "m", mid: "55395830", sid: "ps_test", exp, kid: "urlsign-v1" };
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `https://delivery.test${path}?t=${encoded}.signature`;
}

export interface PlayBodyOptions {
  sid?: string;
  mediaId?: string;
  manifestUrl?: string;
  expiresAt?: string;
  templateId?: string;
  subtitles?: unknown[];
  templates?: unknown[];
}

export function playBody(options: PlayBodyOptions = {}): Record<string, unknown> {
  return {
    sid: options.sid ?? "ps_test_sid",
    manifest_url: options.manifestUrl ?? signedUrl(1_800_000_000),
    expires_at: options.expiresAt ?? isoFromSec(1_800_000_000 + 3600),
    template_id: options.templateId ?? "ctemplate00000000000001",
    subtitles: options.subtitles ?? [],
    templates: options.templates ?? [{ id: "ctemplate00000000000001", name: "原画加密", is_default: true }],
  };
}

/** 推进微任务队列（假时钟触发定时器后驱动 async 流程） */
export async function flush(times = 30): Promise<void> {
  for (let i = 0; i < times; i += 1) await Promise.resolve();
}
