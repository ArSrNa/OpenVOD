// 鉴权（player-sdk-spec.md §3）：四种凭据源 / token 缓存 / single-flight 重登 / storage 注入 / 多账号热切换。
// 不变量 N5：重登一律经配置的凭据源重新 login（v1 无 refresh token）。
import type { HttpClient } from "./client";
import { validateCredential, type ResolvedConfig } from "./config";
import { DeliveryError, PlayerSdkError } from "./errors";
import type { PlayerSdkEvent } from "./events";

/** tokenProvider 可返回裸 token（TTL 未知）或带到期时间的对象（spec §3.1） */
export interface TokenProviderResult {
  access_token: string;
  /** 支持 ISO 8601 字符串或 Unix 秒；缺省 = TTL 未知（缓存至 401 重取） */
  expires_at?: string | number;
}

/** 四种鉴权模式（缺省 = attach：不配置 credential，仅 attachPlayback 可用） */
export type CredentialSource =
  | { mode: "password"; username: string; password: string }
  | {
      mode: "tokenProvider";
      getToken: () => string | TokenProviderResult | Promise<string | TokenProviderResult>;
    }
  | { mode: "static"; token: string; expires_at?: string | number };

/**
 * JWT 持久化注入（spec §3.4）。默认纯内存；SDK 不内置 localStorage（XSS 面，安全责任交宿主显式选择）。
 * 仅存 `{ access_token, expires_at, identity }`，键 `openvod.player-sdk.token`；
 * **绝不存口令、播放 URL、会话信息**。
 */
export interface PlayerSdkStorage {
  get(key: string): string | null | Promise<string | null>;
  set(key: string, value: string): void | Promise<void>;
  remove(key: string): void | Promise<void>;
}

/** 持久化键（spec §3.4） */
export const TOKEN_STORAGE_KEY = "openvod.player-sdk.token";

export interface AuthManagerDeps {
  client: HttpClient;
  config: ResolvedConfig;
  emit: (event: PlayerSdkEvent) => void;
  /** 身份切换回调：清会话缓存 / 停自动续签定时器 / 旧句柄失效（由 playback 提供） */
  onIdentityChange: () => void;
  now: () => number;
}

interface CachedToken {
  access_token: string;
  /** Unix 秒；null = TTL 未知（缓存至 401 重取） */
  expires_at_sec: number | null;
  identity: string;
}

/** 将 `expires_at`（ISO 8601 / Unix 秒 / 毫秒）归一为 Unix 秒；非法返回 null */
export function parseExpiresAt(value: string | number | null | undefined): number | null {
  if (value == null) return null;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value <= 0) return null;
    // 毫秒时间戳（> 1e12）与秒时间戳均可
    return Math.floor(value > 1e12 ? value / 1000 : value);
  }
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : Math.floor(ms / 1000);
}

export class AuthManager {
  private credential: CredentialSource | null;
  private cached: CachedToken | null = null;
  private inflight: Promise<string> | null = null;
  private storageLoaded = false;
  private loginEmitted = false;
  private expiredEmitted = false;

  constructor(private readonly deps: AuthManagerDeps) {
    this.credential = deps.config.credential;
  }

  /** 是否配置了凭据（attach 模式为 false） */
  hasCredential(): boolean {
    return this.credential != null;
  }

  /** 当前身份键（缓存键 / storage identity 校验用；同一身份共享缓存） */
  identityKey(): string | null {
    const credential = this.credential;
    if (!credential) return null;
    switch (credential.mode) {
      case "password":
        return `password:${credential.username}`;
      case "tokenProvider":
        return "tokenProvider";
      case "static":
        return `static:${credential.token}`;
    }
  }

  /**
   * 运行时切换身份（spec §3.5）：清 token / 会话缓存 / 定时器 → 旧句柄 disposed=true → emit auth:changed{switched}。
   * 传 null = 退化为 attach 模式（仅 attachPlayback 可用）。
   */
  setCredential(source: CredentialSource | null): void {
    this.credential = source == null ? null : validateCredential(source);
    this.cached = null;
    this.inflight = null;
    this.loginEmitted = false;
    this.expiredEmitted = false;
    void this.clearStored();
    this.deps.onIdentityChange();
    this.deps.emit({ type: "auth:changed", reason: "switched" });
  }

  /**
   * 取有效 JWT（spec §3.2）：
   * - 缓存命中且在 leeway 之外 → 零请求返回；
   * - 进入 leeway 窗口 / force → 经凭据源重新获取（single-flight 并发去重）；
   * - `static` 模式无重登能力：force / 进入 leeway → 抛 DeliveryError + emit auth:changed{expired}。
   */
  async getAccessToken(options?: { force?: boolean }): Promise<string> {
    const credential = this.credential;
    if (!credential) {
      throw new PlayerSdkError(
        "sdk_no_credential",
        "未配置凭据：请用 createPlayerSdk({ credential }) 或 auth.setCredential() 配置（attach 模式仅支持 attachPlayback）",
      );
    }

    if (credential.mode === "static") {
      const expiresAtSec = parseExpiresAt(credential.expires_at);
      if (options?.force || this.isExpiring(expiresAtSec)) {
        this.markExpired();
        throw new DeliveryError(
          "unauthorized",
          "静态 token 已失效（static 模式不具备重登能力）：请注入新 token 或改用 tokenProvider",
          401,
        );
      }
      return credential.token;
    }

    await this.ensureStorageLoaded();

    const identity = this.identityKey() as string;
    if (!options?.force && this.cached && this.cached.identity === identity && !this.isExpiring(this.cached.expires_at_sec)) {
      return this.cached.access_token;
    }
    if (this.inflight) return this.inflight;

    const task = this.acquire(credential, identity).finally(() => {
      if (this.inflight === task) this.inflight = null;
    });
    this.inflight = task;
    return task;
  }

  /**
   * 401 兜底（spec §4.4）：可重登返回 true（调用方重试一次）；`static` 模式标记失效并返回 false。
   * 重登自身失败（invalid_credentials / 网络）时抛错，由调用方透传。
   */
  async recoverUnauthorized(): Promise<boolean> {
    const credential = this.credential;
    if (!credential || credential.mode === "static") {
      this.markExpired();
      return false;
    }
    await this.getAccessToken({ force: true });
    return true;
  }

  /** 标记登录态失效（emit auth:changed{expired}，同一失效周期只发一次） */
  markExpired(): void {
    if (this.expiredEmitted) return;
    this.expiredEmitted = true;
    this.deps.emit({ type: "auth:changed", reason: "expired" });
  }

  // ---- 内部 ----

  private isExpiring(expiresAtSec: number | null): boolean {
    if (expiresAtSec == null) return false; // TTL 未知：缓存至 401 重取
    return expiresAtSec - this.deps.config.jwtRefreshLeewaySec <= Math.floor(this.deps.now() / 1000);
  }

  private async acquire(
    credential: Exclude<CredentialSource, { mode: "static" }>,
    identity: string,
  ): Promise<string> {
    const nowSec = Math.floor(this.deps.now() / 1000);
    let accessToken: string;
    let expiresAtSec: number | null;

    if (credential.mode === "password") {
      const body = (await this.deps.client.json({
        method: "POST",
        path: "/v1/auth/login",
        body: { username: credential.username, password: credential.password },
      })) as { access_token?: unknown; expires_in?: unknown } | null;
      if (!body || typeof body.access_token !== "string" || !body.access_token) {
        throw new PlayerSdkError("sdk_bad_response", "login 响应缺少 access_token（检查 baseUrl 是否指向分发端）");
      }
      accessToken = body.access_token;
      expiresAtSec =
        typeof body.expires_in === "number" && Number.isFinite(body.expires_in)
          ? nowSec + Math.floor(body.expires_in)
          : null;
    } else {
      const result = await credential.getToken();
      if (typeof result === "string") {
        if (!result) throw new PlayerSdkError("sdk_bad_response", "tokenProvider.getToken 返回了空字符串");
        accessToken = result;
        expiresAtSec = null;
      } else if (result && typeof result === "object" && typeof result.access_token === "string" && result.access_token) {
        accessToken = result.access_token;
        expiresAtSec = parseExpiresAt(result.expires_at);
      } else {
        throw new PlayerSdkError(
          "sdk_bad_response",
          "tokenProvider.getToken 必须返回 token 字符串或 { access_token, expires_at }",
        );
      }
    }

    this.cached = { access_token: accessToken, expires_at_sec: expiresAtSec, identity };
    this.expiredEmitted = false;
    void this.persistStored();
    this.deps.emit({ type: "auth:changed", reason: this.loginEmitted ? "refresh" : "login" });
    this.loginEmitted = true;
    return accessToken;
  }

  private async ensureStorageLoaded(): Promise<void> {
    if (this.storageLoaded) return;
    this.storageLoaded = true;
    const storage = this.deps.config.storage;
    if (!storage) return;
    try {
      const raw = await storage.get(TOKEN_STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as { access_token?: unknown; expires_at?: unknown; identity?: unknown };
      // 形状校验：脏数据一律丢弃并静默重登（spec §3.4）
      if (!parsed || typeof parsed.access_token !== "string" || !parsed.access_token) return;
      if (typeof parsed.identity !== "string" || parsed.identity !== this.identityKey()) return;
      const expiresAtSec = typeof parsed.expires_at === "string" ? parseExpiresAt(parsed.expires_at) : null;
      if (expiresAtSec != null && expiresAtSec <= Math.floor(this.deps.now() / 1000)) return;
      this.cached = { access_token: parsed.access_token, expires_at_sec: expiresAtSec, identity: parsed.identity };
    } catch {
      // 读取 / 解析失败：忽略（不阻断）
    }
  }

  private async persistStored(): Promise<void> {
    const storage = this.deps.config.storage;
    const cached = this.cached;
    if (!storage || !cached) return;
    try {
      await storage.set(
        TOKEN_STORAGE_KEY,
        JSON.stringify({
          access_token: cached.access_token,
          expires_at: cached.expires_at_sec == null ? null : new Date(cached.expires_at_sec * 1000).toISOString(),
          identity: cached.identity,
        }),
      );
    } catch {
      // 持久化失败不影响内存缓存
    }
  }

  private async clearStored(): Promise<void> {
    const storage = this.deps.config.storage;
    if (!storage) return;
    try {
      await storage.remove(TOKEN_STORAGE_KEY);
    } catch {
      // 忽略
    }
  }
}
