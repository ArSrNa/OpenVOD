"use client";

// 浏览器直连分发端（spec.md §11.3）：业务 API 用 JWT（Bearer），清单 / 密钥 / 分片走 URL 签名 token。
// JWT 由服务端 /api/session 用预览账号换发（凭据不下发浏览器），这里只负责持有与刷新：
// token 存 sessionStorage（刷新保留、关标签页失效即可）；401 → 清 token 重走一次 /api/session。
// 分发端地址由 /api/session **运行时下发**（`delivery_base`，spec.md §11.2）：容器 / 镜像改 env 即生效，
// 不依赖构建期 NEXT_PUBLIC_* 内联；页面加载后首次请求必经 session 刷新该地址。
import { envValue } from "./env";
import type { MediaDetailDTO, MediaListItemDTO, PlaybackDTO } from "./types";

/** 兜底默认（session 响应未带 delivery_base 时；口径与 /api/session 一致） */
const FALLBACK_BASE_URL = (envValue(process.env.NEXT_PUBLIC_DELIVERY_BASE_URL) || "http://127.0.0.1:9000").replace(/\/+$/, "");

const BASE_STORAGE_KEY = "openvod.player.deliveryBase";

/** 浏览器直连分发端地址：以 /api/session 下发的值为准，sessionStorage 兜住页面内多次请求 */
function currentBaseUrl(): string {
  if (typeof window === "undefined") return FALLBACK_BASE_URL;
  try {
    return window.sessionStorage.getItem(BASE_STORAGE_KEY)?.trim() || FALLBACK_BASE_URL;
  } catch {
    return FALLBACK_BASE_URL;
  }
}

function writeBaseUrl(base: string | undefined): void {
  if (typeof window === "undefined" || !base) return;
  try {
    window.sessionStorage.setItem(BASE_STORAGE_KEY, base.replace(/\/+$/, ""));
  } catch {
    // 隐私模式等场景静默；后续按兜底默认请求
  }
}

export class DeliveryError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "DeliveryError";
  }
}

const TOKEN_STORAGE_KEY = "openvod.player.token";

interface StoredToken {
  accessToken: string;
  expiresAtSec: number;
}

function readStoredToken(): StoredToken | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.sessionStorage.getItem(TOKEN_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredToken;
    if (typeof parsed?.accessToken !== "string" || typeof parsed?.expiresAtSec !== "number") return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeStoredToken(token: StoredToken | null): void {
  if (typeof window === "undefined") return;
  try {
    if (token) window.sessionStorage.setItem(TOKEN_STORAGE_KEY, JSON.stringify(token));
    else window.sessionStorage.removeItem(TOKEN_STORAGE_KEY);
  } catch {
    // 隐私模式等场景静默；下次仍走 /api/session
  }
}

interface SessionResponse {
  access_token?: string;
  expires_at?: string;
  /** 浏览器直连分发端地址（运行时下发，spec.md §11.2） */
  delivery_base?: string;
  error?: { code?: string; message?: string };
}

/** 页面加载后首次请求必走一次 /api/session（刷新 delivery_base 与 token）；其后缓存有效则直接用 */
let sessionBootstrapped = false;

/** 取会话 JWT：本地缓存有效（留 10s 余量）直接用；否则调 /api/session（服务端缓存命中不重复 login） */
export async function getAccessToken(force = false): Promise<string> {
  const nowSec = Math.floor(Date.now() / 1000);
  const stored = readStoredToken();
  if (!force && sessionBootstrapped && stored && stored.expiresAtSec - 10 > nowSec) return stored.accessToken;

  let res: Response;
  try {
    res = await fetch("/api/session", { cache: "no-store" });
  } catch (e) {
    throw new DeliveryError("internal", `无法请求会话接口：${(e as Error).message}`, 0);
  }
  const body = (await res.json().catch(() => null)) as SessionResponse | null;
  if (!res.ok || !body?.access_token) {
    throw new DeliveryError(
      body?.error?.code ?? "internal",
      body?.error?.message ?? `会话接口返回 HTTP ${res.status}`,
      res.status,
    );
  }
  sessionBootstrapped = true;
  writeBaseUrl(body.delivery_base);
  const expiresAtSec = body.expires_at ? Math.floor(new Date(body.expires_at).getTime() / 1000) : nowSec + 3600;
  writeStoredToken({ accessToken: body.access_token, expiresAtSec });
  return body.access_token;
}

async function requestWithToken(path: string, init: RequestInit | undefined, force: boolean): Promise<Response> {
  const token = await getAccessToken(force);
  return fetch(`${currentBaseUrl()}${path}`, {
    ...init,
    headers: { ...(init?.headers ?? {}), authorization: `Bearer ${token}` },
    cache: "no-store",
  });
}

/** 分发端 JSON 请求（业务 API）：401 → 清 token 重走 /api/session 再试一次；仍失败由调用方呈现错误态 */
export async function deliveryJson<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await requestWithToken(path, init, false);
    if (res.status === 401) {
      writeStoredToken(null);
      res = await requestWithToken(path, init, true);
    }
  } catch (e) {
    if (e instanceof DeliveryError) throw e;
    throw new DeliveryError(
      "internal",
      `无法连接分发端（${currentBaseUrl()}）：${(e as Error).message}（检查分发端是否已启动 / CORS 是否放行播放器源站）`,
      0,
    );
  }
  const body = (await res.json().catch(() => null)) as
    | (T & { error?: { code?: string; message?: string } })
    | null;
  if (!res.ok) {
    throw new DeliveryError(
      body?.error?.code ?? "internal",
      body?.error?.message ?? `分发端返回 HTTP ${res.status}`,
      res.status,
    );
  }
  return body as T;
}

// ---- 分发端业务调用（spec.md §6.1） ----

export interface MediaPage {
  items: MediaListItemDTO[];
  next_cursor: string | null;
}

export function listMedia(limit = 50): Promise<MediaPage> {
  return deliveryJson<MediaPage>(`/v1/media?limit=${limit}`);
}

export function mediaDetail(id: string): Promise<MediaDetailDTO> {
  return deliveryJson<MediaDetailDTO>(`/v1/media/${encodeURIComponent(id)}`);
}

/**
 * 建 / 复用播放会话（幂等；切换模板复用同一会话）。
 * templateId：undefined = 自动选择；"" 显式旧布局；非空 = 指定模板产物。
 */
export function playMedia(id: string, templateId?: string | null): Promise<PlaybackDTO> {
  const body = templateId == null ? {} : { template_id: templateId };
  return deliveryJson<PlaybackDTO>(`/v1/media/${encodeURIComponent(id)}/play`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
