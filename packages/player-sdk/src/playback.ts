// 播放会话与生命周期治理（player-sdk-spec.md §4 / §5，SDK 核心）：
// - play 的本地缓存语义与同媒资串行化 / single-flight（§4.2 / §5.3）；
// - 到期前自动重签（§4.3，含 30s 重试一次后停止）与 403 bad_token 重签重试（§4.4）；
// - 清晰度切换（§5.2，复用会话换源）与 attach 接管（§5.4）。
// 不变量：N2 签名 URL 原样透出（不拼接 / 不裁剪）；N3 会话复用 / 模板选择 / token 校验一律以服务端为准。
import type { PlaybackRequest, PlaybackTemplateDTO, z } from "@openvod/contracts";
import type { AuthManager } from "./auth";
import type { HttpClient } from "./client";
import type { ResolvedConfig } from "./config";
import { DeliveryError, PlayerSdkError, toSdkError } from "./errors";
import type { PlayerSdkEmitter, SdkOperation } from "./events";
import type { AuthedRequestFn } from "./media";
import { fetchVttText, findMatchingTrack, sanitizeSubtitles, type PlaybackSubtitle } from "./subtitles";

export type PlaybackTemplate = z.infer<typeof PlaybackTemplateDTO>;

/** play 请求体（以契约 schema 约束字段名，防手拼漂移；空对象 = 全部缺省） */
type PlaybackRequestBody = z.infer<typeof PlaybackRequest>;

export interface PlayOptions {
  /** 指定模板产物（proceed/{id}/{templateId}/）；缺省 / null = 按服务端自动选择（spec.md §6.3） */
  templateId?: string | null;
  /** 强制新建会话（仍受并发上限约束，§4.5）；缺省复用 */
  forceNew?: boolean;
  signal?: AbortSignal;
}

/** attach 接管（§5.4）：零请求注册已有签名 URL 的播放描述 */
export interface AttachedPlayback {
  media_id: string;
  manifest_url: string;
  expires_at?: string | null;
  sid?: string;
  template_id?: string | null;
  subtitles?: PlaybackSubtitle[];
  templates?: PlaybackTemplate[];
}

/** 播放句柄：可更新视图（同一媒资同一实例，getter 读取最新值；switchTemplate / refresh 原位更新并返回自身） */
export interface PlaybackHandle {
  /** SDK 字段：play 传入的媒资 ID（服务端无此 wire 字段） */
  readonly media_id: string;
  /** 以下字段与 play 响应逐字一致（spec.md §6.1 / §11.1） */
  readonly sid: string;
  readonly manifest_url: string;
  /** ISO 8601（会话到期时间） */
  readonly expires_at: string;
  /** `""` = 旧布局 */
  readonly template_id: string;
  readonly subtitles: PlaybackSubtitle[];
  readonly templates: PlaybackTemplate[];
  /** SDK 字段 */
  readonly disposed: boolean;

  /** 复用会话换源：指定另一套模板产物（§5.2）；返回同一 handle（视图更新） */
  switchTemplate(templateId: string, options?: { signal?: AbortSignal }): Promise<PlaybackHandle>;
  /** 重新签发（复用会话）：force=true 跳过本地缓存强制请求 */
  refresh(options?: { force?: boolean; signal?: AbortSignal }): Promise<PlaybackHandle>;
  /** 拉取本句柄字幕的 VTT 文本（403 bad_token 自动重签重试一次，§4.4 / §6） */
  fetchSubtitleText(track: PlaybackSubtitle, options?: { signal?: AbortSignal }): Promise<string>;
  /** 停自动续签 + 本地失效（服务端无释放端点，会话按 TTL 自然过期，§4.6） */
  dispose(): void;
}

interface HandleState {
  media_id: string;
  sid: string;
  manifest_url: string;
  expires_at: string;
  template_id: string;
  subtitles: PlaybackSubtitle[];
  templates: PlaybackTemplate[];
  disposed: boolean;
  /** 本次会话显式请求的模板选择（null = 自动）；refresh 沿用它防止「重签回默认清晰度」 */
  requestedTemplateId: string | null;
}

interface Entry {
  mediaId: string;
  handle: PlaybackHandleImpl | null;
  /** 同媒资操作串行化队列（§5.3；队列本身永不 reject） */
  queue: Promise<void>;
  refreshTimer: ReturnType<typeof setTimeout> | null;
  retryTimer: ReturnType<typeof setTimeout> | null;
  /** 自动续签失败重试后仍失败 → 停止自动（防故障放大，§4.3） */
  autoStopped: boolean;
}

export interface PlaybackManagerDeps {
  client: HttpClient;
  auth: AuthManager;
  config: ResolvedConfig;
  emitter: PlayerSdkEmitter;
  /** 带 401 兜底重试的业务请求（入口装配，list / detail / play 共用） */
  authedRequest: AuthedRequestFn;
  now: () => number;
}

/** 自动续签失败后的重试延迟（spec §4.3：30s 后重试一次） */
export const AUTO_REFRESH_RETRY_MS = 30_000;
/** 定时器最小间隔（防「leeway ≥ TTL」配置下的紧循环） */
const MIN_REFRESH_DELAY_MS = 1_000;

const B64URL_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

function unref(timer: ReturnType<typeof setTimeout>): void {
  (timer as unknown as { unref?: () => void }).unref?.();
}

/** base64url → ASCII 字符串（零依赖实现；token 载荷为 ASCII JSON） */
function decodeBase64Url(input: string): string | null {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const ch of input) {
    const index = B64URL_ALPHABET.indexOf(ch);
    if (index < 0) return null;
    value = (value << 6) | index;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out += String.fromCharCode((value >> bits) & 0xff);
    }
  }
  return out;
}

/**
 * 解析签名 URL 的 query `t` 载荷 `exp`（base64url JSON）。
 * **仅作续签调度用途：不验签、不用于任何安全判断**（spec §4.3）；解析失败返回 null。
 */
export function manifestTokenExp(url: string): number | null {
  try {
    const queryIndex = url.indexOf("?");
    if (queryIndex < 0) return null;
    const token = new URLSearchParams(url.slice(queryIndex + 1)).get("t");
    if (!token) return null;
    const payloadB64 = token.split(".")[0];
    if (!payloadB64) return null;
    const json = decodeBase64Url(payloadB64);
    if (!json) return null;
    const payload = JSON.parse(json) as { exp?: unknown };
    return typeof payload?.exp === "number" && Number.isFinite(payload.exp) ? payload.exp : null;
  } catch {
    return null;
  }
}

/** ISO 8601 → Unix 秒（非法 / 空 → null） */
export function parseIsoSeconds(value: string | null | undefined): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : Math.floor(ms / 1000);
}

function sanitizeTemplates(value: unknown): PlaybackTemplate[] {
  if (!Array.isArray(value)) return [];
  const out: PlaybackTemplate[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const raw = item as Record<string, unknown>;
    if (typeof raw.id !== "string" || !raw.id) continue;
    out.push({
      id: raw.id,
      name: typeof raw.name === "string" ? raw.name : null,
      is_default: raw.is_default === true,
    });
  }
  return out;
}

/** play 响应 → 句柄状态（关键字段缺失 → sdk_bad_response，spec §8） */
function normalizePlaybackResponse(mediaId: string, body: unknown): HandleState {
  if (!body || typeof body !== "object") {
    throw new PlayerSdkError("sdk_bad_response", `play 响应不是对象（media ${mediaId}）`);
  }
  const raw = body as Record<string, unknown>;
  if (
    typeof raw.sid !== "string" ||
    typeof raw.manifest_url !== "string" ||
    !raw.manifest_url ||
    typeof raw.expires_at !== "string" ||
    typeof raw.template_id !== "string"
  ) {
    throw new PlayerSdkError(
      "sdk_bad_response",
      `play 响应缺少必需字段（sid / manifest_url / expires_at / template_id，media ${mediaId}）`,
    );
  }
  return {
    media_id: mediaId,
    sid: raw.sid,
    manifest_url: raw.manifest_url,
    expires_at: raw.expires_at,
    template_id: raw.template_id,
    subtitles: sanitizeSubtitles(raw.subtitles),
    templates: sanitizeTemplates(raw.templates),
    disposed: false,
    requestedTemplateId: null,
  };
}

/** 播放句柄实现：字段 getter 读最新状态；失效（disposed）后操作一律抛 sdk_disposed */
export class PlaybackHandleImpl implements PlaybackHandle {
  constructor(
    private readonly manager: PlaybackManager,
    private readonly state: HandleState,
  ) {}

  get media_id(): string {
    return this.state.media_id;
  }
  get sid(): string {
    return this.state.sid;
  }
  get manifest_url(): string {
    return this.state.manifest_url;
  }
  get expires_at(): string {
    return this.state.expires_at;
  }
  get template_id(): string {
    return this.state.template_id;
  }
  get subtitles(): PlaybackSubtitle[] {
    return this.state.subtitles;
  }
  get templates(): PlaybackTemplate[] {
    return this.state.templates;
  }
  get disposed(): boolean {
    return this.state.disposed;
  }

  async switchTemplate(templateId: string, options?: { signal?: AbortSignal }): Promise<PlaybackHandle> {
    this.assertUsable();
    this.manager.requireCredential();
    // 与当前产物一致 → 空操作（零请求，spec §4.2）
    if (templateId === this.state.template_id) return this;
    try {
      await this.manager.switchTemplate(this, templateId, options?.signal);
    } catch (error) {
      if (!options?.signal?.aborted) this.manager.emitError("switch_template", error);
      throw error; // 失败不改变现有 handle（不打断当前播放，§5.2）
    }
    return this;
  }

  async refresh(options?: { force?: boolean; signal?: AbortSignal }): Promise<PlaybackHandle> {
    this.assertUsable();
    this.manager.requireCredential(); // 无凭据：attach 透传句柄不能重签（spec §5.4）
    try {
      const requested = await this.manager.refresh(this, {
        force: options?.force ?? false,
        signal: options?.signal,
      });
      if (requested) this.manager.emitRefreshed(this, "manual");
    } catch (error) {
      if (!options?.signal?.aborted) this.manager.emitError("refresh", error);
      throw error;
    }
    return this;
  }

  async fetchSubtitleText(track: PlaybackSubtitle, options?: { signal?: AbortSignal }): Promise<string> {
    this.assertUsable();
    try {
      return await fetchVttText(this.manager.client, track.url, options?.signal);
    } catch (error) {
      const transient = error instanceof DeliveryError && error.code === "bad_token" && !options?.signal?.aborted;
      if (!transient) {
        if (!options?.signal?.aborted) this.manager.emitError("subtitle", error);
        throw error;
      }
      // 403 bad_token → 复用会话重签 → 用新 URL 重试一次（每请求仅一次，spec §4.4）
      try {
        await this.manager.refresh(this, { force: true, signal: options?.signal });
        const fresh = findMatchingTrack(this.state.subtitles, track);
        if (!fresh || fresh.url === track.url) throw error;
        return await fetchVttText(this.manager.client, fresh.url, options?.signal);
      } catch (retryError) {
        if (!options?.signal?.aborted) this.manager.emitError("subtitle", retryError);
        throw retryError;
      }
    }
  }

  dispose(): void {
    this.manager.disposeHandle(this);
  }

  assertUsable(): void {
    if (this.state.disposed) {
      throw new PlayerSdkError(
        "sdk_disposed",
        `播放句柄已释放（media ${this.state.media_id}）：请重新 play()；身份切换 / sdk.dispose() 也会使旧句柄失效`,
      );
    }
  }

  /** 内部：原位更新（不对外暴露；manager 在请求成功后调用） */
  _update(next: Partial<HandleState>): void {
    Object.assign(this.state, next);
  }

  _state(): HandleState {
    return this.state;
  }
}

export class PlaybackManager {
  private readonly entries = new Map<string, Entry>();
  /** 同媒资同语义请求的 single-flight（§4.2 并发去重） */
  private readonly inflight = new Map<string, { key: string; promise: Promise<PlaybackHandle> }>();
  private disposed = false;

  constructor(readonly deps: PlaybackManagerDeps) {}

  get client(): HttpClient {
    return this.deps.client;
  }

  // ---- 公共入口（接口语义见 spec §2.3 / §4 / §5） ----

  async play(mediaId: string, options: PlayOptions = {}): Promise<PlaybackHandle> {
    this.assertNotDisposed();
    const templateId = options.templateId ?? null;
    const forceNew = options.forceNew ?? false;
    const key = `play|${templateId ?? "*"}|${forceNew ? 1 : 0}`;

    const running = this.inflight.get(mediaId);
    if (running && running.key === key) return running.promise;

    const promise = this.serialize(mediaId, async () => {
      const entry = this.entryFor(mediaId);
      const current = entry.handle;
      const previousTemplateId = current && !current.disposed ? current.template_id : null;
      if (current && !current.disposed) {
        // 指定 templateId 且等于当前 → 空操作（§4.2）
        if (!forceNew && templateId != null && templateId === current.template_id) return current as PlaybackHandle;
        // 未指定 templateId / forceNew 且缓存新鲜 → 直接返回缓存 handle（零请求，§4.2）
        if (!forceNew && templateId == null && !this.isStale(current)) return current as PlaybackHandle;
      }
      const handle = await this.requestPlay(entry, { templateId, forceNew, signal: options.signal });
      // §4.2：显式指定不同 templateId 的 play 等价「切换」→ emit playback:template_changed
      if (previousTemplateId != null && templateId != null && !forceNew && handle.template_id !== previousTemplateId) {
        this.deps.emitter.emit({
          type: "playback:template_changed",
          media_id: handle.media_id,
          template_id: handle.template_id,
          manifest_url: handle.manifest_url,
        });
      }
      return handle;
    });

    this.inflight.set(mediaId, { key, promise });
    const clear = () => {
      const current = this.inflight.get(mediaId);
      if (current && current.promise === promise) this.inflight.delete(mediaId);
    };
    void promise.then(clear, clear);
    return promise;
  }

  /** attach 接管（§5.4）：零请求注册已有签名 URL */
  attach(descriptor: AttachedPlayback): PlaybackHandle {
    this.assertNotDisposed();
    if (!descriptor || typeof descriptor.media_id !== "string" || !descriptor.media_id) {
      throw new PlayerSdkError("sdk_bad_response", "attachPlayback 需要 descriptor.media_id");
    }
    if (typeof descriptor.manifest_url !== "string" || !descriptor.manifest_url) {
      throw new PlayerSdkError("sdk_bad_response", "attachPlayback 需要 descriptor.manifest_url（已有签名 URL）");
    }
    const entry = this.entryFor(descriptor.media_id);
    this.clearTimers(entry);
    entry.autoStopped = false;
    const handle = new PlaybackHandleImpl(this, {
      media_id: descriptor.media_id,
      sid: descriptor.sid ?? "",
      manifest_url: descriptor.manifest_url,
      expires_at: descriptor.expires_at ?? "",
      template_id: descriptor.template_id ?? "",
      subtitles: sanitizeSubtitles(descriptor.subtitles),
      templates: sanitizeTemplates(descriptor.templates),
      disposed: false,
      requestedTemplateId: descriptor.template_id ?? null,
    });
    entry.handle = handle;
    // 无 expires_at → 不排程自动续签（§5.4：attach「无到期信息」，即使清单 token 自身带 exp）；
    // 有 expires_at 时仍要求 credential（scheduleAutoRefresh 内部判断）
    if (descriptor.expires_at) {
      this.scheduleAutoRefresh(entry);
    } else {
      this.clearTimers(entry);
    }
    return handle;
  }

  /** 重新签发（复用会话，§4.2）：返回是否真的发起了请求（false = 本地缓存新鲜，零请求） */
  async refresh(
    handle: PlaybackHandleImpl,
    options: { force: boolean; signal?: AbortSignal },
  ): Promise<boolean> {
    this.assertNotDisposed();
    return this.serialize(handle.media_id, async () => {
      this.assertHandleAlive(handle);
      const entry = this.entryFor(handle.media_id);
      if (!options.force && !this.isStale(handle._state())) return false;
      await this.requestPlay(entry, {
        templateId: handle._state().requestedTemplateId,
        forceNew: false,
        signal: options.signal,
      });
      return true;
    });
  }

  /** 复用会话换源（§5.2）：成功后句柄原位更新 + emit playback:template_changed */
  async switchTemplate(handle: PlaybackHandleImpl, templateId: string, signal?: AbortSignal): Promise<void> {
    this.assertNotDisposed();
    await this.serialize(handle.media_id, async () => {
      this.assertHandleAlive(handle);
      const entry = this.entryFor(handle.media_id);
      await this.requestPlay(entry, { templateId, forceNew: false, signal });
      this.deps.emitter.emit({
        type: "playback:template_changed",
        media_id: handle.media_id,
        template_id: handle.template_id,
        manifest_url: handle.manifest_url,
      });
    });
  }

  /** 无凭据（attach 模式）时 refresh / switchTemplate 的显式拒绝（spec §5.4） */
  requireCredential(): void {
    if (!this.deps.auth.hasCredential()) {
      throw new PlayerSdkError(
        "sdk_no_credential",
        "未配置凭据（attach 模式仅透传已有签名 URL）：refresh / switchTemplate 需要 credential（password / tokenProvider / static）",
      );
    }
  }

  /** 按轨道定位所属句柄（sdk.fetchSubtitleText 便利入口用；匹配不到返回 null） */
  findByTrack(track: PlaybackSubtitle): PlaybackHandleImpl | null {
    let byId: PlaybackHandleImpl | null = null;
    for (const entry of this.entries.values()) {
      const handle = entry.handle;
      if (!handle || handle.disposed) continue;
      if (handle.subtitles.some((t) => t.id === track.id && t.url === track.url)) return handle;
      if (!byId && handle.subtitles.some((t) => t.id === track.id)) byId = handle;
    }
    return byId;
  }

  // ---- 释放语义（§4.6：服务端无释放端点，仅停定时器 + 本地失效） ----

  disposeHandle(handle: PlaybackHandleImpl): void {
    if (handle.disposed) return;
    handle._update({ disposed: true });
    const entry = this.entries.get(handle.media_id);
    if (entry && entry.handle === handle) {
      this.clearTimers(entry);
      this.entries.delete(handle.media_id);
    }
    this.inflight.delete(handle.media_id);
  }

  /** 身份切换（spec §3.5）：停全部定时器 + 清会话缓存 + 旧句柄 disposed=true */
  handleIdentityChange(): void {
    this.disposeAll();
  }

  disposeAll(): void {
    for (const entry of this.entries.values()) {
      this.clearTimers(entry);
      if (entry.handle) entry.handle._update({ disposed: true });
    }
    this.entries.clear();
    this.inflight.clear();
  }

  dispose(): void {
    this.disposed = true;
    this.disposeAll();
  }

  // ---- 事件辅助（handle 与内部流程共用） ----

  emitRefreshed(handle: PlaybackHandle, reason: "auto" | "manual" | "retry"): void {
    this.deps.emitter.emit({
      type: "playback:refreshed",
      media_id: handle.media_id,
      manifest_url: handle.manifest_url,
      expires_at: handle.expires_at,
      reason,
    });
  }

  emitError(operation: SdkOperation, error: unknown): void {
    this.deps.emitter.emit({ type: "error", operation, error: toSdkError(error) });
  }

  // ---- 内部实现 ----

  private assertNotDisposed(): void {
    if (this.disposed) {
      throw new PlayerSdkError("sdk_disposed", "SDK 实例已 dispose()：请重新 createPlayerSdk()");
    }
  }

  private assertHandleAlive(handle: PlaybackHandleImpl): void {
    handle.assertUsable();
  }

  private entryFor(mediaId: string): Entry {
    let entry = this.entries.get(mediaId);
    if (!entry) {
      entry = {
        mediaId,
        handle: null,
        queue: Promise.resolve(),
        refreshTimer: null,
        retryTimer: null,
        autoStopped: false,
      };
      this.entries.set(mediaId, entry);
    }
    return entry;
  }

  /** 同媒资操作串行化（§5.3）：队列按提交顺序执行，不同媒资可并发 */
  private serialize<T>(mediaId: string, task: () => Promise<T>): Promise<T> {
    const entry = this.entryFor(mediaId);
    const previous = entry.queue;
    let release!: () => void;
    entry.queue = new Promise<void>((resolve) => {
      release = resolve;
    });
    return (async () => {
      await previous.catch(() => undefined);
      try {
        return await task();
      } finally {
        release();
      }
    })();
  }

  /** 发起 play 请求并在成功后原位更新句柄 + 重排自动续签 */
  private async requestPlay(
    entry: Entry,
    opts: { templateId: string | null; forceNew: boolean; signal?: AbortSignal },
  ): Promise<PlaybackHandle> {
    const body: PlaybackRequestBody = {};
    if (opts.forceNew) body.force_new = true;
    if (opts.templateId != null) body.template_id = opts.templateId;

    const response = await this.deps.authedRequest("play", {
      method: "POST",
      path: `/v1/media/${encodeURIComponent(entry.mediaId)}/play`,
      body,
      signal: opts.signal,
    });

    const next = normalizePlaybackResponse(entry.mediaId, response);
    next.requestedTemplateId = opts.templateId;

    let handle = entry.handle;
    if (!handle || handle.disposed) {
      handle = new PlaybackHandleImpl(this, next);
      entry.handle = handle;
    } else {
      handle._update(next);
    }
    entry.autoStopped = false;
    this.scheduleAutoRefresh(entry);
    return handle;
  }

  /** 到期时刻（Unix 秒）= min(会话 exp, 清单 token exp) - refreshLeewaySec；无信息 → null */
  private nextRefreshAtSec(handle: { manifest_url: string; expires_at: string }): number | null {
    const sessionExp = parseIsoSeconds(handle.expires_at);
    const tokenExp = manifestTokenExp(handle.manifest_url);
    const candidates = [sessionExp, tokenExp].filter((v): v is number => v != null);
    if (!candidates.length) return null;
    return Math.min(...candidates) - this.deps.config.refreshLeewaySec;
  }

  /** 缓存是否已进入 leeway / 缺失到期信息（§4.2） */
  isStale(handle: { manifest_url: string; expires_at: string }): boolean {
    const at = this.nextRefreshAtSec(handle);
    if (at == null) return true;
    return at * 1000 <= this.deps.now();
  }

  private scheduleAutoRefresh(entry: Entry): void {
    this.clearTimers(entry);
    if (this.disposed || !this.deps.config.autoRefresh || entry.autoStopped) return;
    const handle = entry.handle;
    if (!handle || handle.disposed) return;
    // attach 无凭据 → 无法重签，不排程（§5.4）
    if (!this.deps.auth.hasCredential()) return;
    const at = this.nextRefreshAtSec(handle);
    if (at == null) return;
    const delay = Math.max(MIN_REFRESH_DELAY_MS, at * 1000 - this.deps.now());
    entry.refreshTimer = setTimeout(() => {
      void this.runAutoRefresh(entry);
    }, delay);
    unref(entry.refreshTimer);
  }

  /** 自动续签（§4.3）：成功 → emit refreshed{auto} + 重新排程；失败 → 30s 后重试一次 */
  private async runAutoRefresh(entry: Entry): Promise<void> {
    entry.refreshTimer = null;
    const handle = entry.handle;
    if (this.disposed || !handle || handle.disposed || entry.autoStopped) return;
    const requestedTemplateId = handle._state().requestedTemplateId;

    const attempt = () =>
      this.serialize(entry.mediaId, async () => {
        const current = entry.handle;
        if (!current || current.disposed) throw new PlayerSdkError("sdk_disposed", "播放句柄已释放，自动续签中止");
        await this.requestPlay(entry, { templateId: requestedTemplateId, forceNew: false });
      });

    try {
      await attempt();
      const refreshed = entry.handle;
      if (refreshed && !refreshed.disposed) this.emitRefreshed(refreshed, "auto");
    } catch {
      entry.retryTimer = setTimeout(() => {
        void this.retryAutoRefresh(entry, requestedTemplateId);
      }, AUTO_REFRESH_RETRY_MS);
      unref(entry.retryTimer);
    }
  }

  private async retryAutoRefresh(entry: Entry, requestedTemplateId: string | null): Promise<void> {
    entry.retryTimer = null;
    if (this.disposed) return;
    try {
      await this.serialize(entry.mediaId, async () => {
        const current = entry.handle;
        if (!current || current.disposed) throw new PlayerSdkError("sdk_disposed", "播放句柄已释放，自动续签中止");
        await this.requestPlay(entry, { templateId: requestedTemplateId, forceNew: false });
      });
      const refreshed = entry.handle;
      if (refreshed && !refreshed.disposed) this.emitRefreshed(refreshed, "retry");
    } catch (error) {
      // 仍失败 → 停止自动（防故障放大；宿主可手动 refresh()，§4.3）
      entry.autoStopped = true;
      this.emitError("auto_refresh", error);
    }
  }

  private clearTimers(entry: Entry): void {
    if (entry.refreshTimer) {
      clearTimeout(entry.refreshTimer);
      entry.refreshTimer = null;
    }
    if (entry.retryTimer) {
      clearTimeout(entry.retryTimer);
      entry.retryTimer = null;
    }
  }
}
