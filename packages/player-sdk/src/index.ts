// OpenVOD 播放器 SDK（openvod-jssdk）入口：createPlayerSdk + 公共类型 / 辅助函数导出。
// 权威设计见 docs/vod/player-sdk-spec.md / player-sdk-intent.md。
//
// 设计不变量（任何改动不得违反）：
// - N1 SDK 永不接触视频字节与密钥材料（不请求 /key、不下载分片、不持有 CEK）；
// - N2 所有签名 URL 一律来自 play 响应原样透出（不本地生成 / 校验 / 改写）；
// - N3 业务语义以服务端为准（limit 回退 / 模板自动选择 / 会话复用 / token 校验不复制）；
// - N4 错误保真（服务端错误码 / 文案 / HTTP 状态原样透出，SDK 只附加 hint）；
// - N5 重登一律经配置的凭据源重新 login（v1 无 refresh token）。
import { AuthManager, type CredentialSource, type PlayerSdkStorage } from "./auth";
import { HttpClient, type JsonRequestOptions } from "./client";
import { resolveConfig, type PlayerSdkConfig } from "./config";
import { DeliveryError, PlayerSdkError, toSdkError } from "./errors";
import { createEmitter, type PlayerSdkEmitter, type PlayerSdkEvent, type PlayerSdkEventListener, type SdkOperation } from "./events";
import { MediaApi, type MediaDetail, type MediaPage } from "./media";
import { PlaybackManager, type AttachedPlayback, type PlaybackHandle, type PlayOptions } from "./playback";
import { fetchVttText, type PlaybackSubtitle } from "./subtitles";

/** SDK 实例（spec §2.3） */
export interface PlayerSdk {
  readonly auth: {
    /** 取有效 JWT：缓存命中零请求；到期前按 jwtRefreshLeewaySec 重登；401 强制重登（§4.4） */
    getAccessToken(options?: { force?: boolean }): Promise<string>;
    /** 运行时切换身份：清 token / 会话缓存 / 定时器，旧句柄全部失效（§3.5）；null = 退化为 attach 模式 */
    setCredential(source: CredentialSource | null): void;
  };

  /** 媒资列表（GET /v1/media；恒为 READY；next_cursor v1 恒 null，透传） */
  listMedia(options?: { limit?: number; signal?: AbortSignal }): Promise<MediaPage>;
  /** 媒资详情（GET /v1/media/{id}；非 READY 仍返回详情，playable=false） */
  getMedia(mediaId: string, options?: { signal?: AbortSignal }): Promise<MediaDetail>;

  /** 建 / 复用播放会话并签发签名 URL（§4.1 / §4.2）；同媒资默认命中本地缓存（零请求） */
  play(mediaId: string, options?: PlayOptions): Promise<PlaybackHandle>;
  /** 接管已有签名 URL：零请求（§5.4）；无 credential 时 refresh / switchTemplate 抛 sdk_no_credential */
  attachPlayback(descriptor: AttachedPlayback): PlaybackHandle;
  /** 拉取字幕 VTT 文本（自动定位所属句柄以支持 403 重签重试；未命中句柄则直接请求按原样失败） */
  fetchSubtitleText(track: PlaybackSubtitle, options?: { signal?: AbortSignal }): Promise<string>;

  /** 事件订阅（按类型收窄 payload）；返回取消函数 */
  on<T extends PlayerSdkEvent["type"]>(
    type: T,
    listener: (event: Extract<PlayerSdkEvent, { type: T }>) => void,
  ): () => void;
  on(listener: PlayerSdkEventListener): () => void;
  /** 清全部定时器与缓存（不释放服务端会话，§4.6） */
  dispose(): void;
}

/**
 * 创建播放器 SDK（**同步构造、零网络请求**；配置非法抛 `PlayerSdkError("sdk_invalid_config")`）。
 *
 * ```ts
 * const sdk = createPlayerSdk({ baseUrl: "https://vod.example.com", credential: { mode: "password", username, password } });
 * const handle = await sdk.play("55395830");
 * video.src = handle.manifest_url;   // 清单 / 密钥 / 分片全链路已带签名
 * ```
 */
export function createPlayerSdk(config: PlayerSdkConfig): PlayerSdk {
  const cfg = resolveConfig(config);
  const emitter: PlayerSdkEmitter = createEmitter();
  if (cfg.onEvent) emitter.on(null, cfg.onEvent);

  const client = new HttpClient({
    baseUrl: cfg.baseUrl,
    fetch: cfg.fetch,
    timeoutMs: cfg.timeoutMs,
    retries: cfg.retries,
  });

  let playbackRef: PlaybackManager | null = null;
  const auth = new AuthManager({
    client,
    config: cfg,
    now: () => Date.now(),
    emit: (event) => emitter.emit(event),
    onIdentityChange: () => playbackRef?.handleIdentityChange(),
  });

  /**
   * 业务请求 + 401 兜底（spec §4.4）：401 `unauthorized` → 强制重登一次 → 重试原请求一次；
   * 二次仍 401 → 抛错 + `auth:changed{expired}`；`static` 模式不重登（recoverUnauthorized=false）直接抛。
   */
  async function authedRequest(
    _operation: SdkOperation,
    opts: Omit<JsonRequestOptions, "token" | "retry">,
  ): Promise<unknown> {
    const token = await auth.getAccessToken();
    try {
      return await client.json({ ...opts, token });
    } catch (error) {
      if (!(error instanceof DeliveryError) || error.code !== "unauthorized") throw error;
      const recovered = await auth.recoverUnauthorized();
      if (!recovered) throw error;
      const retryToken = await auth.getAccessToken();
      try {
        return await client.json({ ...opts, token: retryToken });
      } catch (retryError) {
        if (retryError instanceof DeliveryError && retryError.code === "unauthorized") auth.markExpired();
        throw retryError;
      }
    }
  }

  const media = new MediaApi(authedRequest);
  const playback = new PlaybackManager({
    client,
    auth,
    config: cfg,
    emitter,
    authedRequest,
    now: () => Date.now(),
  });
  playbackRef = playback;

  let disposed = false;
  const assertNotDisposed = () => {
    if (disposed) throw new PlayerSdkError("sdk_disposed", "SDK 实例已 dispose()：请重新 createPlayerSdk()");
  };
  const emitError = (operation: SdkOperation, error: unknown, signal?: AbortSignal) => {
    if (signal?.aborted) return; // 调用方主动取消不算错误
    emitter.emit({ type: "error", operation, error: toSdkError(error) });
  };

  function on(rawType: unknown, maybeListener?: unknown): () => void {
    if (typeof rawType === "function") return emitter.on(null, rawType as PlayerSdkEventListener);
    if (typeof maybeListener !== "function") {
      throw new PlayerSdkError("sdk_invalid_config", "on(type, listener) 需要 listener 函数");
    }
    return emitter.on(rawType as PlayerSdkEvent["type"], maybeListener as PlayerSdkEventListener);
  }

  const sdk: PlayerSdk = {
    auth: {
      getAccessToken: async (options) => {
        assertNotDisposed();
        try {
          return await auth.getAccessToken(options);
        } catch (error) {
          emitter.emit({ type: "error", operation: "login", error: toSdkError(error) });
          throw error;
        }
      },
      setCredential: (source) => {
        assertNotDisposed();
        auth.setCredential(source);
      },
    },

    listMedia: async (options) => {
      assertNotDisposed();
      try {
        return await media.listMedia(options);
      } catch (error) {
        emitError("list_media", error, options?.signal);
        throw error;
      }
    },

    getMedia: async (mediaId, options) => {
      assertNotDisposed();
      try {
        return await media.getMedia(mediaId, options);
      } catch (error) {
        emitError("get_media", error, options?.signal);
        throw error;
      }
    },

    play: async (mediaId, options) => {
      assertNotDisposed();
      try {
        return await playback.play(mediaId, options ?? {});
      } catch (error) {
        emitError("play", error, options?.signal);
        throw error;
      }
    },

    attachPlayback: (descriptor) => {
      assertNotDisposed();
      return playback.attach(descriptor);
    },

    fetchSubtitleText: async (track, options) => {
      assertNotDisposed();
      const handle = playback.findByTrack(track);
      if (handle && !handle.disposed) return handle.fetchSubtitleText(track, options);
      try {
        return await fetchVttText(client, track.url, options?.signal);
      } catch (error) {
        emitError("subtitle", error, options?.signal);
        throw error;
      }
    },

    on,

    dispose: () => {
      if (disposed) return;
      disposed = true;
      playback.dispose();
    },
  };

  return sdk;
}

// ---- 公共类型与辅助函数（spec §2.2） ----
export { DeliveryError, PlayerSdkError, describeError } from "./errors";
export type { DeliveryErrorCode, PlayerSdkErrorCode } from "./errors";
export { parseCustomMetadata, templateLabel } from "./media";
export type { MediaListItem, MediaDetail, MediaPage, MediaPage as PageResponse, CustomMetadata } from "./media";
export type { PlaybackSubtitle } from "./subtitles";
export type { PlaybackHandle, PlayOptions, AttachedPlayback, PlaybackTemplate } from "./playback";
export type { MediaProbe, MediaSubtitle, PlaybackRequest } from "./types";
export type { PlayerSdkConfig } from "./config";
export type { CredentialSource, PlayerSdkStorage, TokenProviderResult } from "./auth";
export type { PlayerSdkEvent, PlayerSdkEventListener, SdkOperation } from "./events";
export type { FetchLike } from "./client";
