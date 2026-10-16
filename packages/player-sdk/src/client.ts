// HTTP 传输（player-sdk-spec.md §1）：baseUrl 规范化 / fetch 注入 / 超时 / 幂等 GET 重试 / 错误信封解析。
// 只用 fetch（可注入），不依赖任何第三方库；浏览器 / Node 18+ / RN 同一份实现（不变量 N1：永不下载视频字节）。
import { DeliveryError, ERROR_HINTS, PlayerSdkError, type DeliveryErrorCode } from "./errors";

/** fetch 形态（与全局 fetch 兼容；RN / 测试 / 自定义代理可注入） */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface HttpClientConfig {
  baseUrl: string;
  fetch: FetchLike;
  timeoutMs: number;
  /** 幂等 GET 的网络层重试次数（不含 401 / 403 兜底流程，spec §2.2） */
  retries: number;
}

export interface JsonRequestOptions {
  method: "GET" | "POST";
  /** 相对路径（以 / 开头） */
  path: string;
  body?: unknown;
  token?: string | null;
  signal?: AbortSignal;
  /** 幂等 GET 网络层重试开关（POST 恒不重试） */
  retry?: boolean;
}

function isKnownErrorCode(code: string): code is DeliveryErrorCode {
  return Object.prototype.hasOwnProperty.call(ERROR_HINTS, code);
}

export class HttpClient {
  constructor(private readonly cfg: HttpClientConfig) {}

  /** 业务面 JSON 请求（/v1/media*）：非 2xx 抛 DeliveryError（错误信封解析，N4 保真） */
  async json<T = unknown>(opts: JsonRequestOptions): Promise<T> {
    const res = await this.send({
      method: opts.method,
      url: opts.path,
      body: opts.body,
      token: opts.token,
      signal: opts.signal,
      retry: opts.retry ?? opts.method === "GET",
    });
    if (!res.ok) throw await toDeliveryError(res);
    const text = await res.text();
    if (!text) return null as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new PlayerSdkError(
        "sdk_bad_response",
        `分发端响应不是合法 JSON：${opts.method} ${opts.path}（HTTP ${res.status}）`,
      );
    }
  }

  /** 绝对 URL 文本请求（字幕 VTT，spec §6）：非 2xx 抛 DeliveryError */
  async text(url: string, options: { signal?: AbortSignal; retry?: boolean } = {}): Promise<string> {
    const res = await this.send({
      method: "GET",
      url,
      signal: options.signal,
      retry: options.retry ?? true,
    });
    if (!res.ok) throw await toDeliveryError(res);
    return res.text();
  }

  // ---- 内部 ----

  private absoluteUrl(url: string): string {
    return /^https?:\/\//i.test(url) ? url : `${this.cfg.baseUrl}${url}`;
  }

  private async send(req: {
    method: string;
    url: string;
    body?: unknown;
    token?: string | null;
    signal?: AbortSignal;
    retry: boolean;
  }): Promise<Response> {
    const attempts = req.retry ? Math.max(0, this.cfg.retries) + 1 : 1;
    let lastError: DeliveryError | null = null;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        const res = await this.fetchOnce(req);
        // GET 网络层重试：5xx 视为可重试（幂等）
        if (res.status >= 500 && req.retry && attempt < attempts - 1) continue;
        return res;
      } catch (error) {
        if (!(error instanceof DeliveryError)) throw error;
        lastError = error;
        if (attempt >= attempts - 1) throw error;
      }
    }
    throw lastError ?? new DeliveryError("internal", "请求失败", 0);
  }

  private async fetchOnce(req: {
    method: string;
    url: string;
    body?: unknown;
    token?: string | null;
    signal?: AbortSignal;
  }): Promise<Response> {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.cfg.timeoutMs);
    (timer as unknown as { unref?: () => void }).unref?.();

    const onOuterAbort = () => controller.abort();
    if (req.signal) {
      if (req.signal.aborted) {
        clearTimeout(timer);
        throw new DeliveryError("internal", "请求已取消", 0);
      }
      req.signal.addEventListener("abort", onOuterAbort, { once: true });
    }

    try {
      const headers: Record<string, string> = {};
      if (req.body !== undefined) headers["content-type"] = "application/json";
      if (req.token) headers["authorization"] = `Bearer ${req.token}`;
      return await this.cfg.fetch(this.absoluteUrl(req.url), {
        method: req.method,
        headers,
        body: req.body === undefined ? undefined : JSON.stringify(req.body),
        // m3u8 / 密钥 / 字幕响应恒 no-store（P0）；业务 JSON 请求同样避免中间缓存
        cache: "no-store",
        signal: controller.signal,
      });
    } catch (error) {
      if (timedOut) {
        throw new DeliveryError("internal", `请求超时（${this.cfg.timeoutMs}ms）：${req.method} ${req.url}`, 0);
      }
      if (req.signal?.aborted) throw new DeliveryError("internal", "请求已取消", 0);
      throw new DeliveryError(
        "internal",
        `无法连接分发端（${this.cfg.baseUrl}）：${error instanceof Error ? error.message : String(error)}` +
          "（检查分发端是否已启动 / CORS 是否放行当前源站）",
        0,
      );
    } finally {
      clearTimeout(timer);
      req.signal?.removeEventListener("abort", onOuterAbort);
    }
  }
}

/** 非 2xx → DeliveryError：解析错误信封 `{ error: { code, message } }`；无法解析 / 未知码 → internal（spec §8） */
export async function toDeliveryError(res: Response): Promise<DeliveryError> {
  let code: string | undefined;
  let message: string | undefined;
  try {
    const body = (await res.json()) as { error?: { code?: unknown; message?: unknown } } | null;
    if (body && typeof body === "object" && body.error && typeof body.error === "object") {
      if (typeof body.error.code === "string") code = body.error.code;
      if (typeof body.error.message === "string" && body.error.message) message = body.error.message;
    }
  } catch {
    // 非 JSON 错误体（网关 HTML / 空体）→ 统一 internal，状态码保真
  }
  if (code && isKnownErrorCode(code)) {
    return new DeliveryError(code, message ?? `分发端返回 HTTP ${res.status}`, res.status);
  }
  return new DeliveryError("internal", message ?? `分发端返回 HTTP ${res.status}`, res.status);
}
