#!/usr/bin/env -S bun --no-env-file
/**
 * 部署后确认公开域名的请求确实到达 delivery，而非 EdgeOne 静态页或其他服务。
 * 用法：bun --no-env-file scripts/check-delivery-deployment.ts https://delivery.example.com
 *
 * 不需要账号、现有媒资或播放 token，不读取 .env，也不输出响应正文。
 * unsigned 403 当前不承诺 no-store；本检查不能替代有效签名清单 / 密钥响应的
 * Cache-Control: no-store 门禁（ADR-0006）。
 */

type Fetcher = (url: string, init: RequestInit) => Promise<Response>;

export interface CheckResult {
  name: string;
  path: string;
  ok: boolean;
  detail: string;
}

interface Probe {
  name: string;
  path: string;
  status: number;
  errorCode?: string;
}

const probes: Probe[] = [
  { name: "健康检查", path: "/healthz", status: 200 },
  { name: "无签名主清单", path: "/v1/media/00000000/manifest/master.m3u8", status: 403, errorCode: "bad_token" },
  { name: "无签名子清单", path: "/v1/media/00000000/manifest/720p/index.m3u8", status: 403, errorCode: "bad_token" },
  { name: "无签名密钥", path: "/v1/media/00000000/key", status: 403, errorCode: "bad_token" },
  { name: "无签名字幕", path: "/v1/media/00000000/subtitles/c0000000000000000000000000.vtt", status: 403, errorCode: "bad_token" },
  { name: "未登录媒资列表", path: "/v1/media", status: 401, errorCode: "unauthorized" },
];

function parseBaseURL(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("base URL 必须是完整的 HTTP(S) 地址");
  }
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error("base URL 必须使用 HTTP(S)，且不能带账号、密码、查询参数或片段");
  }
  return url.toString().replace(/\/+$/, "");
}

async function readJSON(response: Response): Promise<unknown> {
  // 平台错误页可能很大；限制读取量，既不转储正文，也不无限缓冲异常响应。
  const reader = response.body?.getReader();
  if (!reader) throw new Error("empty body");
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > 64 * 1024) throw new Error("body too large");
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
    return JSON.parse(text);
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

async function checkProbe(base: string, probe: Probe, fetcher: Fetcher, timeoutMs: number): Promise<CheckResult> {
  const result = (ok: boolean, detail: string): CheckResult => ({ name: probe.name, path: probe.path, ok, detail });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetcher(base + probe.path, {
      method: "GET",
      redirect: "manual",
      signal: controller.signal,
      headers: { Accept: "application/json", "Cache-Control": "no-cache" },
    });
    const contentType = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
    if (response.status === 404 && contentType === "text/html") {
      await response.body?.cancel();
      return result(false, "收到平台 HTML 404，未到达 delivery；检查自定义域名绑定、生产部署及 Cloud Functions 路由");
    }
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      return result(false, `收到 HTTP ${response.status} 重定向（未跟随）；检查公开域名与函数路由`);
    }
    if (response.status !== probe.status || contentType !== "application/json") {
      await response.body?.cancel();
      return result(false, `预期 HTTP ${probe.status} JSON，实际 HTTP ${response.status}${contentType === "application/json" ? " JSON" : " 非 JSON"}`);
    }

    let body: Record<string, unknown> | undefined;
    try {
      body = record(await readJSON(response));
    } catch {
      if (controller.signal.aborted) return result(false, `请求超过 ${timeoutMs}ms`);
      return result(false, "响应不是有效 JSON 或超过 64 KiB");
    }
    if (probe.errorCode) {
      if (record(body?.error)?.code !== probe.errorCode) {
        return result(false, `响应缺少 delivery 错误码 ${probe.errorCode}`);
      }
    } else if (body?.app !== "delivery" || body.status !== "ok") {
      return result(false, "健康检查未返回 app=delivery 和 status=ok");
    }
    return result(true, `HTTP ${response.status}${probe.errorCode ? ` ${probe.errorCode}` : " delivery ok"}`);
  } catch {
    // fetch 异常可能携带 URL / 代理凭据；仅输出固定诊断，不输出 error.message。
    return result(false, controller.signal.aborted ? `请求超过 ${timeoutMs}ms` : "请求失败；检查 DNS、TLS、网络及函数启动日志");
  } finally {
    clearTimeout(timeout);
  }
}

export async function checkDeliveryDeployment(
  baseURL: string,
  options: { fetcher?: Fetcher; timeoutMs?: number } = {},
): Promise<CheckResult[]> {
  const base = parseBaseURL(baseURL);
  const timeoutMs = options.timeoutMs ?? 10_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new Error("请求超时必须是正整数毫秒");
  return Promise.all(probes.map((probe) => checkProbe(base, probe, options.fetcher ?? fetch, timeoutMs)));
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.length !== 1) {
    console.error("用法：bun --no-env-file scripts/check-delivery-deployment.ts <base URL>");
    process.exitCode = 1;
  } else {
    try {
      const results = await checkDeliveryDeployment(args[0]);
      for (const result of results) console.log(`[${result.ok ? "OK" : "FAIL"}] ${result.name}: ${result.detail}`);
      const passed = results.filter((result) => result.ok).length;
      console.log(`delivery 部署检查：${passed}/${results.length} 通过`);
      process.exitCode = passed === results.length ? 0 : 1;
    } catch (error) {
      // 此处仅捕获参数校验错误；网络与响应错误均由 checkProbe 转为固定文本。
      console.error(error instanceof Error ? error.message : "部署检查失败");
      process.exitCode = 1;
    }
  }
}
