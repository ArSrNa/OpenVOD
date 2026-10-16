"use client";

// 播放器 SDK 宿主接线（S2，player-sdk-spec.md §12.3）：以 **tokenProvider** 模式接入——
// getToken 调 Next 路由 /api/session（服务端读预览账号调分发端 login，**凭据不下发浏览器**，spec.md §11.3）。
// delivery 浏览器直连地址由 /api/session **运行时下发**（`delivery_base`，spec.md §11.8）：页面加载后
// 首次请求先取一次 session，用其中的地址创建 SDK —— 镜像一次构建跨环境部署，不依赖构建期 NEXT_PUBLIC_* 内联。
import { createPlayerSdk, DeliveryError, type DeliveryErrorCode, type PlayerSdk } from "@openvod/player-sdk";

import { envValue } from "./env";

/** 兜底默认（session 响应未带 delivery_base 时；口径与 /api/session 一致） */
const FALLBACK_BASE_URL = (envValue(process.env.NEXT_PUBLIC_DELIVERY_BASE_URL) || "http://127.0.0.1:9000").replace(
  /\/+$/,
  "",
);

interface SessionPayload {
  access_token: string;
  expires_at?: string;
  delivery_base?: string;
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
  return { access_token: body.access_token, expires_at: body.expires_at, delivery_base: body.delivery_base };
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

let sdkCache: { baseUrl: string; sdk: PlayerSdk } | null = null;

/** 取（按 delivery_base 缓存的）SDK 实例：列表页 / 播放页共享同一实例与会话缓存 */
export async function getSdk(): Promise<PlayerSdk> {
  const session = await loadSessionOnce();
  const baseUrl = (session.delivery_base || FALLBACK_BASE_URL).replace(/\/+$/, "");
  if (!sdkCache || sdkCache.baseUrl !== baseUrl) {
    sdkCache?.sdk.dispose();
    sdkCache = {
      baseUrl,
      sdk: createPlayerSdk({
        baseUrl,
        credential: { mode: "tokenProvider", getToken },
      }),
    };
  }
  return sdkCache.sdk;
}
