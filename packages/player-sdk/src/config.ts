// 配置校验与默认值（player-sdk-spec.md §2.2）：createPlayerSdk 同步构造、零网络请求；
// 配置非法一律抛 PlayerSdkError("sdk_invalid_config")。
import type { CredentialSource, PlayerSdkStorage } from "./auth";
import type { FetchLike } from "./client";
import { PlayerSdkError } from "./errors";
import type { PlayerSdkEvent } from "./events";

export const DEFAULT_TIMEOUT_MS = 10_000;
export const DEFAULT_JWT_REFRESH_LEEWAY_SEC = 300;
export const DEFAULT_REFRESH_LEEWAY_SEC = 300;

export interface PlayerSdkConfig {
  /** delivery 基址（必填；仅 http/https，自动去尾斜杠） */
  baseUrl: string;
  /** 凭据源；缺省 = attach 模式（仅 attachPlayback 可用） */
  credential?: CredentialSource;
  /** 注入 fetch（RN / 测试 / 自定义代理）；缺省 globalThis.fetch */
  fetch?: FetchLike;
  /** 单请求超时（ms），缺省 10000 */
  timeoutMs?: number;
  /** 幂等 GET 的网络层重试次数（不含 §4.4 的 401 / 403 流程），缺省 0 */
  retries?: number;
  /** JWT 到期前多久触发重登（秒），缺省 300 */
  jwtRefreshLeewaySec?: number;
  /** 会话 / 清单 token 到期前多久触发自动重签（秒），缺省 300 */
  refreshLeewaySec?: number;
  /** 到期前自动重签（§4.3），缺省 true */
  autoRefresh?: boolean;
  /** JWT 持久化注入（§3.4）；缺省纯内存 */
  storage?: PlayerSdkStorage;
  /** 全局事件监听（等价 sdk.on(listener)） */
  onEvent?: (event: PlayerSdkEvent) => void;
}

export interface ResolvedConfig {
  baseUrl: string;
  credential: CredentialSource | null;
  fetch: FetchLike;
  timeoutMs: number;
  retries: number;
  jwtRefreshLeewaySec: number;
  refreshLeewaySec: number;
  autoRefresh: boolean;
  storage: PlayerSdkStorage | null;
  onEvent: ((event: PlayerSdkEvent) => void) | null;
}

function invalid(message: string): PlayerSdkError {
  return new PlayerSdkError("sdk_invalid_config", message);
}

function positiveInt(value: unknown, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw invalid(`${name} 必须是正整数（当前：${String(value)}）`);
  }
  return value;
}

function nonNegativeInt(value: unknown, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw invalid(`${name} 必须是非负整数（当前：${String(value)}）`);
  }
  return value;
}

/** baseUrl 规范化：trim + 去尾斜杠 + 仅 http/https */
export function normalizeBaseUrl(raw: unknown): string {
  if (typeof raw !== "string" || !raw.trim()) {
    throw invalid("baseUrl 必填（delivery 地址，如 https://vod.example.com）");
  }
  const value = raw.trim().replace(/\/+$/, "");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw invalid(`baseUrl 不是合法 URL：${raw}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw invalid(`baseUrl 仅支持 http/https（当前：${url.protocol}）`);
  }
  return value;
}

/** 凭据源校验（构造与 setCredential 共用） */
export function validateCredential(source: CredentialSource): CredentialSource {
  if (!source || typeof source !== "object") {
    throw invalid("credential 必须是对象（password / tokenProvider / static 三选一）");
  }
  switch (source.mode) {
    case "password":
      if (typeof source.username !== "string" || !source.username) throw invalid("password 模式需要非空 username");
      if (typeof source.password !== "string" || !source.password) throw invalid("password 模式需要非空 password");
      return { mode: "password", username: source.username, password: source.password };
    case "tokenProvider":
      if (typeof source.getToken !== "function") throw invalid("tokenProvider 模式需要 getToken 函数");
      return { mode: "tokenProvider", getToken: source.getToken };
    case "static":
      if (typeof source.token !== "string" || !source.token) throw invalid("static 模式需要非空 token");
      return { mode: "static", token: source.token, expires_at: source.expires_at };
    default:
      throw invalid(`未知 credential.mode：${String((source as { mode?: unknown }).mode)}`);
  }
}

function validateStorage(storage: unknown): void {
  if (storage === undefined) return;
  const candidate = storage as Partial<PlayerSdkStorage>;
  if (
    !storage ||
    typeof storage !== "object" ||
    typeof candidate.get !== "function" ||
    typeof candidate.set !== "function" ||
    typeof candidate.remove !== "function"
  ) {
    throw invalid("storage 必须实现 get / set / remove 三个方法（spec §3.4）");
  }
}

export function resolveConfig(config: PlayerSdkConfig): ResolvedConfig {
  if (!config || typeof config !== "object") {
    throw invalid("createPlayerSdk(config) 需要配置对象（至少 baseUrl）");
  }
  const baseUrl = normalizeBaseUrl(config.baseUrl);
  const injectedFetch = config.fetch;
  const globalFetch = typeof globalThis.fetch === "function" ? (globalThis.fetch.bind(globalThis) as FetchLike) : null;
  const fetchImpl = injectedFetch ?? globalFetch;
  if (!fetchImpl || typeof fetchImpl !== "function") {
    throw invalid("找不到 fetch：请注入 config.fetch（Node <18 / 非标准运行时）");
  }
  const autoRefresh = config.autoRefresh ?? true;
  if (typeof autoRefresh !== "boolean") throw invalid("autoRefresh 必须是布尔值");
  if (config.onEvent !== undefined && typeof config.onEvent !== "function") {
    throw invalid("onEvent 必须是函数（等价 sdk.on(listener)）");
  }
  validateStorage(config.storage);

  return {
    baseUrl,
    credential: config.credential == null ? null : validateCredential(config.credential),
    fetch: fetchImpl,
    timeoutMs: positiveInt(config.timeoutMs, DEFAULT_TIMEOUT_MS, "timeoutMs"),
    retries: nonNegativeInt(config.retries, 0, "retries"),
    jwtRefreshLeewaySec: nonNegativeInt(config.jwtRefreshLeewaySec, DEFAULT_JWT_REFRESH_LEEWAY_SEC, "jwtRefreshLeewaySec"),
    refreshLeewaySec: nonNegativeInt(config.refreshLeewaySec, DEFAULT_REFRESH_LEEWAY_SEC, "refreshLeewaySec"),
    autoRefresh,
    storage: config.storage ?? null,
    onEvent: config.onEvent ?? null,
  };
}
