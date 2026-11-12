"use client";

// 播放器 SDK 宿主接线（S2，player-sdk-spec.md §12.3）：以 **tokenProvider** 模式接入——
// getToken 调 Next 路由 /api/session（服务端读预览账号调分发端 login，**凭据不下发浏览器**，spec.md §11.3）。
//
// 2026-11-12（spec.md §11.9）：SDK baseUrl 固定为**同源**代理前缀 `/api/delivery`——浏览器的所有分发端
// 请求都由 player 服务端转发 `DELIVERY_BASE_URL`。浏览器不再需要知道分发端地址，也就不会出现
// 「浏览器访问 127.0.0.1:9000」这类跨视角失败（容器内 / 端口预览场景的通病）。
import { createPlayerSdk, DeliveryError, type DeliveryErrorCode, type PlayerSdk } from "openvod-jssdk";

/** 同源代理前缀（服务端 route handler 见 app/api/delivery/[...path]/route.ts） */
const PROXY_BASE_URL = "/api/delivery";

/** SDK 要求绝对 http(s) URL：以当前页面源站补全（仅在浏览器侧调用） */
function proxyBaseUrl(): string {
  return new URL(PROXY_BASE_URL, window.location.origin).toString().replace(/\/+$/, "");
}

interface SessionPayload {
  access_token: string;
  expires_at?: string;
}

let bootstrap: Promise<SessionPayload> | null = null;
/** 引导结果是否已被 tokenProvider 消费（同一页面加载只取一次 session，其后按需重取） */
let bootstrapServed = false;

/** GET /api/session（服务端进程内缓存 JWT，不重复 login；响应 no-store） */
async function fetchSession(): Promise<SessionPayload> {
  let res: Response;
  try {
    res = await fetch("/api/session", { cache: "no-store" });
  } catch (e) {
    throw new DeliveryError("internal", `无法请求会话接口：${(e as Error).message}`, 0);
  }
  const body = (await res.json().catch(() => null)) as
    | (Partial<SessionPayload> & { error?: { code?: string; message?: string } })
    | null;
  if (!res.ok || !body?.access_token) {
    throw new DeliveryError(
      (body?.error?.code ?? "internal") as DeliveryErrorCode,
      body?.error?.message ?? `会话接口返回 HTTP ${res.status}`,
      res.status,
    );
  }
  return { access_token: body.access_token, expires_at: body.expires_at };
}

/** 页面加载内首次取会话（失败允许下次重试） */
function loadSessionOnce(): Promise<SessionPayload> {
  bootstrap ??= fetchSession().catch((error) => {
    bootstrap = null;
    throw error;
  });
  return bootstrap;
}

/** tokenProvider（SDK 按 expires_at + leeway 自行决定何时重取；401 兜底时 SDK 会强制再取） */
async function getToken(): Promise<{ access_token: string; expires_at?: string }> {
  if (!bootstrapServed) {
    const session = await loadSessionOnce();
    bootstrapServed = true;
    return { access_token: session.access_token, expires_at: session.expires_at };
  }
  const session = await fetchSession();
  return { access_token: session.access_token, expires_at: session.expires_at };
}

let sdkCache: PlayerSdk | null = null;

/** 取 SDK 实例：列表页 / 播放页共享同一实例与会话缓存（代理地址与页面同源，无需按环境重建） */
export function getSdk(): PlayerSdk {
  sdkCache ??= createPlayerSdk({
    baseUrl: proxyBaseUrl(),
    credential: { mode: "tokenProvider", getToken },
  });
  return sdkCache;
}
