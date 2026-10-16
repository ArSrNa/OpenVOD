// 公共 API 表面单测：事件订阅语义（§9）、getMedia（§7）、字幕兜底入口（§6）、配置校验（§2.2）。
// 补齐覆盖率空白（events 的类型化订阅、index 的边界分支、config 的非法分支）。
import { afterEach, beforeEach, describe, expect, it, jest } from "bun:test";
import { createPlayerSdk, PlayerSdkError, type PlayerSdkEvent } from "../src";
import {
  createFetchStub,
  errorResponse,
  isoFromSec,
  jsonResponse,
  playBody,
  rejection,
  signedUrl,
  type RecordedCall,
} from "./helpers";

const BASE = "https://delivery.test";
const MEDIA = "55395830";
const STATIC = { mode: "static" as const, token: "static-jwt" };
const TRACK = {
  id: "ctrack00000000000000001",
  lang: "zh-CN",
  label: "中文",
  is_default: true,
  url: `${BASE}/v1/media/${MEDIA}/subtitles/ctrack00000000000000001.vtt?t=stub`,
};

const PLAY = (call: RecordedCall) => call.path === `/v1/media/${MEDIA}/play`;
const DETAIL = (call: RecordedCall) => call.path === `/v1/media/${MEDIA}`;

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(new Date("2026-01-01T00:00:00Z"));
});

afterEach(() => {
  jest.useRealTimers();
});

describe("事件模型（§9）", () => {
  it("on(type) 只收本型事件；取消订阅生效；监听器抛错被隔离不影响流程", async () => {
    const stub = createFetchStub((call) => {
      if (PLAY(call)) {
        const requested = (call.body as { template_id?: string } | undefined)?.template_id;
        return jsonResponse(
          200,
          playBody({
            templateId: requested ?? "ctpl-a",
            manifestUrl: signedUrl(1_800_000_000),
            expiresAt: isoFromSec(1_800_003_600),
          }),
        );
      }
      return errorResponse(404, "not_found", "路由不存在");
    });
    const sdk = createPlayerSdk({ baseUrl: BASE, credential: STATIC, fetch: stub.fetch, autoRefresh: false });

    const changed: PlayerSdkEvent[] = [];
    const all: PlayerSdkEvent[] = [];
    const off = sdk.on("playback:template_changed", (event) => changed.push(event));
    sdk.on((event) => all.push(event));
    sdk.on("playback:refreshed", () => {
      throw new Error("监听器异常不应影响 SDK");
    });

    const handle = await sdk.play(MEDIA);
    // 手动重签 → playback:refreshed（监听器抛错，SDK 仍应正常完成）
    await handle.refresh({ force: true });
    expect(all.some((e) => e.type === "playback:refreshed" && e.reason === "manual")).toBe(true);
    expect(changed).toHaveLength(0);

    await handle.switchTemplate("ctpl-b");
    expect(changed).toHaveLength(1);
    expect(changed[0]).toMatchObject({ type: "playback:template_changed", template_id: "ctpl-b" });

    off(); // 取消订阅
    await sdk.play(MEDIA, { templateId: "ctpl-c" });
    expect(changed).toHaveLength(1);

    // static 模式没有 login/refresh 的 auth:changed（JWT 由宿主注入）
    expect(all.filter((e) => e.type === "auth:changed")).toHaveLength(0);
  });

  it("on(type, 非函数) 抛 sdk_invalid_config；onEvent 配置等价全量订阅；dispose 幂等", async () => {
    const events: PlayerSdkEvent[] = [];
    const stub = createFetchStub(() => errorResponse(404, "not_found", "路由不存在"));
    const sdk = createPlayerSdk({
      baseUrl: BASE,
      credential: STATIC,
      fetch: stub.fetch,
      onEvent: (event) => events.push(event),
    });

    expect(() => sdk.on("auth:changed", undefined as never)).toThrow(PlayerSdkError);
    await rejection(sdk.listMedia());
    expect(events).toContainEqual(expect.objectContaining({ type: "error", operation: "list_media" }));

    sdk.dispose();
    sdk.dispose(); // 幂等：不抛错
  });
});

describe("媒资详情（§7）", () => {
  it("getMedia：URL 与响应原样透传；失败保真错误码并 emit error{get_media}", async () => {
    const detail = {
      id: MEDIA,
      title: "演示",
      poster_url: null,
      duration_ms: 1000,
      custom: { description: "4K" },
      status: "READY",
      probe: null,
      subtitles: [],
      playable: true,
    };
    const stub = createFetchStub((call) =>
      DETAIL(call) ? jsonResponse(200, detail) : errorResponse(404, "not_found", "媒资不存在"),
    );
    const sdk = createPlayerSdk({ baseUrl: BASE, credential: STATIC, fetch: stub.fetch });
    const events: PlayerSdkEvent[] = [];
    sdk.on((event) => events.push(event));

    const got = await sdk.getMedia(MEDIA);
    expect(got).toMatchObject({ id: MEDIA, title: "演示", playable: true });
    expect(got.custom).toEqual({ description: "4K" });
    expect(stub.calls.at(-1)?.path).toBe(`/v1/media/${MEDIA}`);

    const error = await rejection(sdk.getMedia("99999999"));
    expect(error.code).toBe("not_found");
    expect(error.status).toBe(404);
    expect(events).toContainEqual(expect.objectContaining({ type: "error", operation: "get_media" }));
  });
});

describe("字幕文本入口（§6）", () => {
  it("未命中句柄时直接 GET track.url；失败 emit error{subtitle}", async () => {
    const okStub = createFetchStub(
      () => new Response("WEBVTT\n\n00:00.000 --> 00:01.000\n你好\n", { status: 200, headers: { "content-type": "text/vtt" } }),
    );
    const sdk = createPlayerSdk({ baseUrl: BASE, credential: STATIC, fetch: okStub.fetch });
    expect(await sdk.fetchSubtitleText(TRACK)).toContain("WEBVTT");
    expect(okStub.calls[0].url).toBe(TRACK.url);

    const failStub = createFetchStub(() => errorResponse(404, "not_found", "轨道已删除"));
    const sdk2 = createPlayerSdk({ baseUrl: BASE, credential: STATIC, fetch: failStub.fetch });
    const events: PlayerSdkEvent[] = [];
    sdk2.on((event) => events.push(event));
    const error = await rejection(sdk2.fetchSubtitleText(TRACK));
    expect(error.code).toBe("not_found");
    expect(events).toContainEqual(expect.objectContaining({ type: "error", operation: "subtitle" }));
  });
});

describe("配置校验（§2.2）", () => {
  it("非法配置一律抛 sdk_invalid_config，且不发任何请求", () => {
    const stub = createFetchStub(() => errorResponse(500, "internal", "不应请求"));

    expect(() => createPlayerSdk(undefined as never)).toThrow(PlayerSdkError);
    expect(() => createPlayerSdk({ baseUrl: "not-a-url" })).toThrow(PlayerSdkError);
    expect(() => createPlayerSdk({ baseUrl: BASE, autoRefresh: "yes" as never })).toThrow(PlayerSdkError);
    expect(() => createPlayerSdk({ baseUrl: BASE, onEvent: 1 as never })).toThrow(PlayerSdkError);
    expect(() => createPlayerSdk({ baseUrl: BASE, credential: { mode: "nope" } as never })).toThrow(PlayerSdkError);
    expect(() => createPlayerSdk({ baseUrl: BASE, credential: { mode: "static", token: "" } })).toThrow(PlayerSdkError);
    expect(() => createPlayerSdk({ baseUrl: BASE, storage: { get: () => null } as never })).toThrow(PlayerSdkError);

    // 合法：attach 模式（无 credential）零请求
    createPlayerSdk({ baseUrl: `${BASE}/`, fetch: stub.fetch });
    expect(stub.calls).toHaveLength(0);
  });
});
