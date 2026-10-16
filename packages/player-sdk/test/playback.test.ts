// 播放会话与生命周期单测（player-sdk-spec.md §12.1：T6~T14）
import { afterEach, beforeEach, describe, expect, it, jest } from "bun:test";
import { createPlayerSdk, DeliveryError, type PlayerSdkEvent } from "../src";
import {
  createFetchStub,
  errorResponse,
  flush,
  isoFromSec,
  jsonResponse,
  LOGIN_BODY,
  playBody,
  signedUrl,
  textResponse,
  type FetchStub,
  type RecordedCall,
} from "./helpers";

const BASE = "https://delivery.test";
const MEDIA = "55395830";
const T0 = Math.floor(Date.UTC(2026, 0, 1) / 1000); // 假时钟起点（2026-01-01T00:00:00Z）
const TEMPLATE_A = "ctemplate00000000000001";
const TEMPLATE_B = "ctemplate00000000000002";
const TRACK_ID = "ctrack00000000000000001";

const LOGIN = (call: RecordedCall) => call.path === "/v1/auth/login";
const PLAY = (call: RecordedCall) => call.path === `/v1/media/${MEDIA}/play`;
const SUBTITLE = (call: RecordedCall) => call.path.startsWith(`/v1/media/${MEDIA}/subtitles/`);

function passwordCredential(username = "demo", password = "s3cret") {
  return { mode: "password" as const, username, password };
}

/** 播放响应（token exp 与会话 exp 基于当前假时钟，保证续签时刻可预测） */
function currentPlayBody(options: { templateId?: string; templates?: unknown[]; subtitles?: unknown[]; tokenTtlSec?: number } = {}) {
  const nowSec = Math.floor(Date.now() / 1000);
  const templateId = options.templateId ?? TEMPLATE_A;
  return playBody({
    manifestUrl: `${signedUrl(nowSec + (options.tokenTtlSec ?? 1800))}&tpl=${templateId}`,
    expiresAt: isoFromSec(nowSec + 3600),
    templateId,
    templates: options.templates ?? [
      { id: TEMPLATE_A, name: "原画加密", is_default: true },
      { id: TEMPLATE_B, name: "720p 加密", is_default: false },
    ],
    subtitles: options.subtitles ?? [],
  });
}

function baseHandler(stubState: { playHits: number }): (call: RecordedCall) => Response {
  return (call) => {
    if (LOGIN(call)) return jsonResponse(200, LOGIN_BODY);
    if (PLAY(call)) {
      stubState.playHits += 1;
      const requested = (call.body as { template_id?: string } | undefined)?.template_id;
      return jsonResponse(200, currentPlayBody({ templateId: requested ?? TEMPLATE_A }));
    }
    return errorResponse(404, "not_found", "路由不存在");
  };
}

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(new Date("2026-01-01T00:00:00Z"));
});

afterEach(() => {
  jest.useRealTimers();
});

describe("play 缓存与串行化（§4.2 / §5.3）", () => {
  it("T6/7 同媒资缓存命中零请求；force_new 显式携带；并发调用共享 in-flight", async () => {
    const state = { playHits: 0 };
    const stub = createFetchStub(baseHandler(state));
    const sdk = createPlayerSdk({ baseUrl: BASE, credential: passwordCredential(), fetch: stub.fetch, autoRefresh: false });

    const first = await sdk.play(MEDIA);
    expect(state.playHits).toBe(1);
    expect(stub.calls.filter(PLAY)[0].body).toEqual({}); // 复用会话：不带 force_new / template_id

    const second = await sdk.play(MEDIA);
    expect(second).toBe(first);
    expect(state.playHits).toBe(1); // 缓存命中 → 零请求

    await sdk.play(MEDIA, { templateId: first.template_id });
    expect(state.playHits).toBe(1); // 指定当前 templateId → 空操作

    const forced = await sdk.play(MEDIA, { forceNew: true });
    expect(state.playHits).toBe(2);
    expect(stub.calls.filter(PLAY)[1].body).toEqual({ force_new: true });
    expect(forced).toBe(first); // 同一媒体同一 handle 实例（可更新视图）

    // 并发同语义调用（缓存缺失）→ single-flight：只发 1 次请求，返回同一 handle
    const state2 = { playHits: 0 };
    const stub2 = createFetchStub(baseHandler(state2));
    const sdk2 = createPlayerSdk({ baseUrl: BASE, credential: passwordCredential(), fetch: stub2.fetch, autoRefresh: false });
    const handles = await Promise.all([sdk2.play(MEDIA), sdk2.play(MEDIA), sdk2.play(MEDIA)]);
    expect(new Set(handles).size).toBe(1);
    expect(state2.playHits).toBe(1);
  });

  it("T7b 旧布局：templateId 空串显式透传（不被当作未指定丢弃），再次请求缓存命中", async () => {
    const state = { playHits: 0 };
    const stub = createFetchStub((call) => {
      if (LOGIN(call)) return jsonResponse(200, LOGIN_BODY);
      if (PLAY(call)) {
        state.playHits += 1;
        const requested = (call.body as { template_id?: string } | undefined)?.template_id;
        return jsonResponse(200, currentPlayBody({ templateId: requested ?? "" }));
      }
      return errorResponse(404, "not_found", "路由不存在");
    });
    const sdk = createPlayerSdk({ baseUrl: BASE, credential: passwordCredential(), fetch: stub.fetch, autoRefresh: false });

    const handle = await sdk.play(MEDIA, { templateId: "" });
    expect(stub.calls.filter(PLAY)[0].body).toEqual({ template_id: "" });
    expect(handle.template_id).toBe("");

    await sdk.play(MEDIA, { templateId: "" });
    expect(state.playHits).toBe(1); // 同模板（含旧布局空串）→ 缓存命中零请求
  });

  it("缓存进入 leeway → 重新 play（复用会话）", async () => {
    const state = { playHits: 0 };
    const stub = createFetchStub(baseHandler(state));
    const sdk = createPlayerSdk({ baseUrl: BASE, credential: passwordCredential(), fetch: stub.fetch, autoRefresh: false });

    await sdk.play(MEDIA);
    expect(state.playHits).toBe(1);

    jest.advanceTimersByTime(1_500_000 + 5); // token exp - leeway（1500s）到点
    await sdk.play(MEDIA);
    expect(state.playHits).toBe(2);
    expect(stub.calls.filter(PLAY)[1].body).toEqual({}); // 未指定 → 自动选择
  });
});

describe("自动续签（§4.3 / T8 / T9）", () => {
  it("T8 到点自动重签 → emit playback:refreshed{auto} → 重新排程", async () => {
    const state = { playHits: 0 };
    const stub = createFetchStub(baseHandler(state));
    const sdk = createPlayerSdk({
      baseUrl: BASE,
      credential: passwordCredential(),
      fetch: stub.fetch,
      refreshLeewaySec: 300,
    });
    const events: PlayerSdkEvent[] = [];
    sdk.on((event) => events.push(event));

    await sdk.play(MEDIA);
    expect(state.playHits).toBe(1);

    jest.advanceTimersByTime(1_500_000 + 5);
    await flush();
    expect(state.playHits).toBe(2);
    expect(events.filter((e) => e.type === "playback:refreshed")).toEqual([
      expect.objectContaining({ type: "playback:refreshed", media_id: MEDIA, reason: "auto" }),
    ]);

    // 重新排程：又过一个窗口 → 第三次请求
    jest.advanceTimersByTime(1_500_000 + 100);
    await flush();
    expect(state.playHits).toBe(3);
    expect(events.filter((e) => e.type === "playback:refreshed")).toHaveLength(2);
  });

  it("T8b 自动续签失败 → 30s 重试一次 → 仍失败 emit error{auto_refresh} 并停止", async () => {
    let playHits = 0;
    const stub = createFetchStub((call) => {
      if (LOGIN(call)) return jsonResponse(200, LOGIN_BODY);
      if (PLAY(call)) {
        playHits += 1;
        if (playHits === 1) return jsonResponse(200, currentPlayBody());
        return errorResponse(500, "internal", "签发失败");
      }
      return errorResponse(404, "not_found", "路由不存在");
    });
    const sdk = createPlayerSdk({ baseUrl: BASE, credential: passwordCredential(), fetch: stub.fetch });
    const events: PlayerSdkEvent[] = [];
    sdk.on((event) => events.push(event));

    await sdk.play(MEDIA);
    jest.advanceTimersByTime(1_500_000 + 5);
    await flush();
    expect(playHits).toBe(2); // 首次自动尝试失败（无事件）

    jest.advanceTimersByTime(30_000 + 5);
    await flush();
    expect(playHits).toBe(3); // 30s 重试一次
    expect(
      events.some((e) => e.type === "error" && e.operation === "auto_refresh"),
    ).toBe(true);

    // 停止自动（防故障放大）：再推进很久不再请求
    jest.advanceTimersByTime(10_000_000);
    await flush();
    expect(playHits).toBe(3);
  });

  it("T9 autoRefresh:false 不排程、无事件", async () => {
    const state = { playHits: 0 };
    const stub = createFetchStub(baseHandler(state));
    const sdk = createPlayerSdk({
      baseUrl: BASE,
      credential: passwordCredential(),
      fetch: stub.fetch,
      autoRefresh: false,
    });
    const events: PlayerSdkEvent[] = [];
    sdk.on((event) => events.push(event));

    await sdk.play(MEDIA);
    jest.advanceTimersByTime(10_000_000);
    await flush();
    expect(state.playHits).toBe(1);
    expect(events.filter((e) => e.type === "playback:refreshed")).toHaveLength(0);
  });
});

describe("字幕与 403 兜底（§4.4 / §6 / T10）", () => {
  it("T10 字幕拉取 403 bad_token → 复用会话重签 → 新 URL 重试一次", async () => {
    let playHits = 0;
    let subtitleHits = 0;
    const trackUrl = (token: string) => `${BASE}/v1/media/${MEDIA}/subtitles/${TRACK_ID}.vtt?t=${token}`;
    const stub = createFetchStub((call) => {
      if (LOGIN(call)) return jsonResponse(200, LOGIN_BODY);
      if (PLAY(call)) {
        playHits += 1;
        return jsonResponse(
          200,
          currentPlayBody({
            subtitles: [
              { id: TRACK_ID, lang: "zh-CN", label: "中文", is_default: true, url: trackUrl(`token-${playHits}`) },
            ],
          }),
        );
      }
      if (SUBTITLE(call)) {
        subtitleHits += 1;
        if (subtitleHits === 1) return errorResponse(403, "bad_token", "播放 token 无效或已过期");
        return textResponse(200, "WEBVTT\n\n00:00.000 --> 00:01.000\n你好\n");
      }
      return errorResponse(404, "not_found", "路由不存在");
    });
    const sdk = createPlayerSdk({ baseUrl: BASE, credential: passwordCredential(), fetch: stub.fetch });

    const handle = await sdk.play(MEDIA);
    const text = await handle.fetchSubtitleText(handle.subtitles[0]);
    expect(text).toContain("WEBVTT");
    expect(playHits).toBe(2); // 403 → 重签（复用会话再次 play）
    expect(subtitleHits).toBe(2); // 新 URL 重试一次
    expect(handle.subtitles[0].url).toBe(trackUrl("token-2"));

    // SDK 便利入口：命中句柄 → 委托（同一流程）
    const again = await sdk.fetchSubtitleText(handle.subtitles[0]);
    expect(again).toContain("WEBVTT");
  });
});

describe("清晰度切换（§5.1 / §5.2 / T11）", () => {
  it("T11 switchTemplate：指定 template_id、原位更新 + 事件；失败不改变当前 handle", async () => {
    const state = { playHits: 0 };
    const stub = createFetchStub((call) => {
      if (LOGIN(call)) return jsonResponse(200, LOGIN_BODY);
      if (PLAY(call)) {
        state.playHits += 1;
        const requested = (call.body as { template_id?: string } | undefined)?.template_id;
        if (requested === "cbad00000000000000000000") {
          return errorResponse(409, "not_playable", "指定模板产物不存在（可选：原画加密 / 720p 加密）");
        }
        return jsonResponse(200, currentPlayBody({ templateId: requested ?? TEMPLATE_A }));
      }
      return errorResponse(404, "not_found", "路由不存在");
    });
    const sdk = createPlayerSdk({ baseUrl: BASE, credential: passwordCredential(), fetch: stub.fetch, autoRefresh: false });
    const events: PlayerSdkEvent[] = [];
    sdk.on((event) => events.push(event));

    const handle = await sdk.play(MEDIA);
    await handle.switchTemplate(TEMPLATE_B);
    expect(stub.calls.filter(PLAY).at(-1)!.body).toEqual({ template_id: TEMPLATE_B });
    expect(handle.template_id).toBe(TEMPLATE_B);
    expect(events).toContainEqual(
      expect.objectContaining({ type: "playback:template_changed", media_id: MEDIA, template_id: TEMPLATE_B }),
    );

    // 失败（409 not_playable）→ 不打断当前播放
    const beforeUrl = handle.manifest_url;
    const beforeTemplate = handle.template_id;
    const error = await handle.switchTemplate("cbad00000000000000000000").catch((e) => e as DeliveryError);
    expect(error.code).toBe("not_playable");
    expect(error.status).toBe(409);
    expect(error.message).toContain("指定模板产物不存在");
    expect(handle.manifest_url).toBe(beforeUrl);
    expect(handle.template_id).toBe(beforeTemplate);

    // §4.2：显式指定「不同 templateId」的 play 等价切换 → 同样 emit template_changed
    const beforeEvents = events.filter((e) => e.type === "playback:template_changed").length;
    await sdk.play(MEDIA, { templateId: TEMPLATE_A });
    expect(handle.template_id).toBe(TEMPLATE_A);
    expect(events.filter((e) => e.type === "playback:template_changed")).toHaveLength(beforeEvents + 1);
  });
});

describe("错误映射（T12）", () => {
  it("session_limit：错误保真 + hint 说明 force_new 不绕过", async () => {
    const stub = createFetchStub((call) => {
      if (LOGIN(call)) return jsonResponse(200, LOGIN_BODY);
      if (PLAY(call)) return errorResponse(409, "session_limit", "并发播放会话数已达上限");
      return errorResponse(404, "not_found", "路由不存在");
    });
    const sdk = createPlayerSdk({ baseUrl: BASE, credential: passwordCredential(), fetch: stub.fetch });

    const error = await sdk.play(MEDIA, { forceNew: true }).catch((e) => e as DeliveryError);
    expect(error.code).toBe("session_limit");
    expect(error.status).toBe(409);
    expect(error.message).toBe("并发播放会话数已达上限");
    expect(error.hint).toContain("force_new");
  });

  it("not_playable 透传；play 错误同时 emit error{operation:play}", async () => {
    const stub = createFetchStub((call) => {
      if (LOGIN(call)) return jsonResponse(200, LOGIN_BODY);
      if (PLAY(call)) return errorResponse(409, "not_playable", "媒资尚未就绪");
      return errorResponse(404, "not_found", "路由不存在");
    });
    const sdk = createPlayerSdk({ baseUrl: BASE, credential: passwordCredential(), fetch: stub.fetch });
    const events: PlayerSdkEvent[] = [];
    sdk.on((event) => events.push(event));

    const error = await sdk.play(MEDIA).catch((e) => e as DeliveryError);
    expect(error.code).toBe("not_playable");
    expect(events).toContainEqual(
      expect.objectContaining({ type: "error", operation: "play", error: expect.any(DeliveryError) }),
    );
  });
});

describe("身份热切换与 attach（§3.5 / §5.4 / T13 / T14）", () => {
  it("T13 setCredential：清缓存、旧句柄 disposed、事件 switched，新身份可重新 play", async () => {
    const state = { playHits: 0, loginHits: 0 };
    const stub = createFetchStub((call) => {
      if (LOGIN(call)) {
        state.loginHits += 1;
        return jsonResponse(200, LOGIN_BODY);
      }
      if (PLAY(call)) {
        state.playHits += 1;
        return jsonResponse(200, currentPlayBody());
      }
      return errorResponse(404, "not_found", "路由不存在");
    });
    const sdk = createPlayerSdk({ baseUrl: BASE, credential: passwordCredential(), fetch: stub.fetch, autoRefresh: false });
    const events: PlayerSdkEvent[] = [];
    sdk.on((event) => events.push(event));

    const handle = await sdk.play(MEDIA);
    expect(handle.disposed).toBe(false);

    sdk.auth.setCredential(passwordCredential("user-b", "pw-123456"));
    expect(handle.disposed).toBe(true);
    expect(events).toContainEqual({ type: "auth:changed", reason: "switched" });

    // 旧句柄全部失效
    expect(await handle.refresh().catch((e) => e)).toMatchObject({ code: "sdk_disposed" });

    // 新身份：重新 login + play
    const fresh = await sdk.play(MEDIA);
    expect(fresh).not.toBe(handle);
    expect(fresh.disposed).toBe(false);
    expect(state.loginHits).toBe(2);
    expect(state.playHits).toBe(2);
  });

  it("T14 attachPlayback：零请求；无凭据时 refresh / switchTemplate 抛 sdk_no_credential", async () => {
    const stub = createFetchStub(() => errorResponse(500, "internal", "不应发起请求"));
    const sdk = createPlayerSdk({ baseUrl: BASE, fetch: stub.fetch });
    const handle = sdk.attachPlayback({
      media_id: MEDIA,
      manifest_url: signedUrl(T0 + 1800),
      expires_at: isoFromSec(T0 + 3600),
      sid: "ps_attached",
      template_id: TEMPLATE_A,
    });
    expect(stub.calls).toHaveLength(0); // 纯透传，零请求
    expect(handle.manifest_url).toContain("master.m3u8");

    await expect(handle.refresh()).rejects.toMatchObject({ code: "sdk_no_credential" });
    await expect(handle.switchTemplate(TEMPLATE_B)).rejects.toMatchObject({ code: "sdk_no_credential" });
    // 缓存命中（attach 已注册该媒资句柄）时 play 零请求直接返回；无缓存的媒资必须登录 → 无凭据抛错
    expect(await sdk.play(MEDIA)).toBe(handle);
    await expect(sdk.play("12345678")).rejects.toMatchObject({ code: "sdk_no_credential" });

    // 有凭据：refresh 走真实 play，sid 以服务端为准
    const state = { playHits: 0 };
    const stub2 = createFetchStub(baseHandler(state));
    const sdk2 = createPlayerSdk({ baseUrl: BASE, credential: passwordCredential(), fetch: stub2.fetch });
    const attached = sdk2.attachPlayback({ media_id: MEDIA, manifest_url: signedUrl(T0 + 1800), sid: "ps_attached" });
    await attached.refresh({ force: true });
    expect(state.playHits).toBe(1);
    expect(attached.sid).toBe("ps_test_sid");

    // 无 expires_at → 不排程自动续签（§5.4）；带 expires_at 的 attach 才排程
    const state2 = { playHits: 0 };
    const stub3 = createFetchStub(baseHandler(state2));
    const sdk3 = createPlayerSdk({ baseUrl: BASE, credential: passwordCredential(), fetch: stub3.fetch });
    sdk3.attachPlayback({ media_id: MEDIA, manifest_url: signedUrl(T0 + 1800), sid: "ps_no_exp" });
    jest.advanceTimersByTime(2_000_000);
    await flush();
    expect(state2.playHits).toBe(0);

    sdk3.attachPlayback({
      media_id: MEDIA,
      manifest_url: signedUrl(T0 + 1800),
      expires_at: isoFromSec(T0 + 3600),
      sid: "ps_with_exp",
    });
    jest.advanceTimersByTime(1_500_000 + 5);
    await flush();
    expect(state2.playHits).toBe(1);
  });

  it("dispose：停自动续签 + 本地失效（服务端无释放端点）", async () => {
    const state = { playHits: 0 };
    const stub = createFetchStub(baseHandler(state));
    const sdk = createPlayerSdk({ baseUrl: BASE, credential: passwordCredential(), fetch: stub.fetch });

    const handle = await sdk.play(MEDIA);
    state.playHits = 0;
    handle.dispose();
    expect(handle.disposed).toBe(true);
    expect(await handle.refresh().catch((e) => e)).toMatchObject({ code: "sdk_disposed" });

    jest.advanceTimersByTime(10_000_000);
    await flush();
    expect(state.playHits).toBe(0);

    // sdk.dispose 后全部入口拒绝
    sdk.dispose();
    expect(await sdk.play(MEDIA).catch((e) => e)).toMatchObject({ code: "sdk_disposed" });
    expect(await sdk.listMedia().catch((e) => e)).toMatchObject({ code: "sdk_disposed" });
  });
});
