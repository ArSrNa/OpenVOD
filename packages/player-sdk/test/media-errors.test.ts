// 媒资解析 / 错误模型 / 传输层单测（player-sdk-spec.md §12.1：T15~T17 + 配置校验）
import { afterEach, beforeEach, describe, expect, it, jest } from "bun:test";
import { ERROR_CODES } from "@openvod/shared";
import { createPlayerSdk, DeliveryError, parseCustomMetadata, PlayerSdkError, templateLabel } from "../src";
import { ERROR_HINTS, describeError } from "../src/errors";
import { createFetchStub, errorResponse, flush, jsonResponse, type RecordedCall } from "./helpers";

const BASE = "https://delivery.test";
const MEDIA_PAGE = { items: [], next_cursor: null };
const STATIC = { mode: "static" as const, token: "static-jwt" };

const LIST = (call: RecordedCall) => call.path.startsWith("/v1/media");

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(new Date("2026-01-01T00:00:00Z"));
});

afterEach(() => {
  jest.useRealTimers();
});

describe("配置校验（§2.2）", () => {
  it("createPlayerSdk 同步构造、零网络请求；非法配置抛 sdk_invalid_config", () => {
    const stub = createFetchStub(() => errorResponse(500, "internal", "不应发起请求"));
    createPlayerSdk({ baseUrl: `${BASE}/`, credential: STATIC, fetch: stub.fetch });
    expect(stub.calls).toHaveLength(0);

    expect(() => createPlayerSdk({ baseUrl: "" })).toThrow(PlayerSdkError);
    expect(() => createPlayerSdk({ baseUrl: "ftp://vod.test" })).toThrow(/sdk_invalid_config|仅支持 http/);
    expect(() => createPlayerSdk({ baseUrl: BASE, timeoutMs: 0 })).toThrow(PlayerSdkError);
    expect(() => createPlayerSdk({ baseUrl: BASE, retries: -1 })).toThrow(PlayerSdkError);
    expect(() =>
      createPlayerSdk({ baseUrl: BASE, credential: { mode: "password", username: "u", password: "" } as never }),
    ).toThrow(PlayerSdkError);
    expect(() =>
      createPlayerSdk({ baseUrl: BASE, credential: { mode: "tokenProvider", getToken: null } as never }),
    ).toThrow(PlayerSdkError);
    expect(() =>
      createPlayerSdk({ baseUrl: BASE, storage: { get: () => null } as never }),
    ).toThrow(PlayerSdkError);
  });
});

describe("T15 parseCustomMetadata：脏数据容错", () => {
  it("null / 非对象 / 缺 id / 空 description / 重复 tags 一律收敛", () => {
    expect(parseCustomMetadata(null)).toEqual({});
    expect(parseCustomMetadata(undefined)).toEqual({});
    expect(parseCustomMetadata("custom")).toEqual({});
    expect(parseCustomMetadata([1, 2])).toEqual({});

    // category：id 与 path 均需非空
    expect(parseCustomMetadata({ category: { id: "", path: "电影 / 科幻" } })).toEqual({});
    expect(parseCustomMetadata({ category: { id: "c1", path: "   " } })).toEqual({});
    expect(parseCustomMetadata({ category: { id: " c1 ", name: " 科幻 ", path: " 电影 / 科幻 " } })).toEqual({
      category: { id: "c1", name: "科幻", path: "电影 / 科幻" },
    });
    expect(parseCustomMetadata({ category: 42 })).toEqual({});

    // description：trim 后非空才保留
    expect(parseCustomMetadata({ description: "   " })).toEqual({});
    expect(parseCustomMetadata({ description: " 演唱会 4K 母版 " })).toEqual({ description: "演唱会 4K 母版" });

    // tags：丢弃空项与非字符串、按首现去重
    expect(parseCustomMetadata({ tags: [" a ", "a", "", 3, "b", null] })).toEqual({ tags: ["a", "b"] });
    expect(parseCustomMetadata({ tags: [] })).toEqual({});
    expect(parseCustomMetadata({ tags: "a,b" })).toEqual({});

    // 扩展键（白名单外）不下发
    expect(parseCustomMetadata({ internal_field: "x" })).toEqual({});
  });

  it("templateLabel：name 为 null 时回落 id 前 8 位", () => {
    expect(templateLabel({ id: "ctemplate00000000000001", name: "原画加密" })).toBe("原画加密");
    expect(templateLabel({ id: "ctemplate00000000000001", name: null })).toBe("模板 ctemplat");
  });
});

describe("T16 describeError 覆盖契约 ErrorCode 全表", () => {
  it("文案表键集与 @openvod/shared ERROR_CODES 逐字一致", () => {
    expect(Object.keys(ERROR_HINTS).sort()).toEqual([...ERROR_CODES].sort());
    for (const code of ERROR_CODES) {
      const text = describeError(code);
      expect(text.length).toBeGreaterThan(0);
      expect(text).not.toContain("未知错误码");
    }
    expect(describeError("brand_new_code")).toContain("未知错误码");
    expect(describeError(null)).toContain("缺少错误码");
  });
});

describe("T17 超时 / 网络失败 / 重试", () => {
  it("网络失败 → DeliveryError{code:internal, status:0}；GET 按 retries 重试", async () => {
    let attempts = 0;
    const stub = createFetchStub(() => {
      attempts += 1;
      throw new Error("ECONNREFUSED");
    });
    const sdk = createPlayerSdk({ baseUrl: BASE, credential: STATIC, fetch: stub.fetch, retries: 2 });

    const error = await sdk.listMedia().catch((e) => e as DeliveryError);
    expect(error).toBeInstanceOf(DeliveryError);
    expect(error.code).toBe("internal");
    expect(error.status).toBe(0);
    expect(error.message).toContain("无法连接分发端");
    expect(attempts).toBe(3); // 1 次 + 2 次重试
  });

  it("GET 重试后成功；POST（play）不重试", async () => {
    let attempts = 0;
    const stub = createFetchStub((call) => {
      if (LIST(call)) {
        attempts += 1;
        if (attempts < 3) throw new Error("boom");
        return jsonResponse(200, MEDIA_PAGE);
      }
      if (call.path.endsWith("/play")) {
        attempts += 1;
        throw new Error("boom");
      }
      return errorResponse(404, "not_found", "路由不存在");
    });
    const sdk = createPlayerSdk({ baseUrl: BASE, credential: STATIC, fetch: stub.fetch, retries: 2 });

    const page = await sdk.listMedia();
    expect(page).toEqual(MEDIA_PAGE);
    expect(attempts).toBe(3);

    attempts = 0;
    const error = await sdk.play("55395830").catch((e) => e as DeliveryError);
    expect(error.code).toBe("internal");
    expect(attempts).toBe(1); // POST 不重试
  });

  it("超时 → DeliveryError{internal, status:0}（请求被 abort）", async () => {
    const stub = createFetchStub(
      (call) =>
        new Promise<Response>((_, reject) => {
          call.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    );
    const sdk = createPlayerSdk({ baseUrl: BASE, credential: STATIC, fetch: stub.fetch, timeoutMs: 50 });

    const pending = sdk.listMedia().catch((e) => e as DeliveryError);
    await flush(); // 先让请求真正发起（内部 setTimeout 注册到假时钟）
    jest.advanceTimersByTime(60);
    await flush();
    const error = await pending;
    expect(error.code).toBe("internal");
    expect(error.status).toBe(0);
    expect(error.message).toContain("请求超时");
  });

  it("非 JSON 错误体 → internal + HTTP 状态保真；错误信封码透传", async () => {
    const htmlStub = createFetchStub(() => new Response("<html>bad gateway</html>", { status: 502 }));
    const sdk = createPlayerSdk({ baseUrl: BASE, credential: STATIC, fetch: htmlStub.fetch });
    const error = await sdk.listMedia().catch((e) => e as DeliveryError);
    expect(error.code).toBe("internal");
    expect(error.status).toBe(502);

    const envelopeStub = createFetchStub(() => errorResponse(409, "not_playable", "媒资尚未就绪"));
    const sdk2 = createPlayerSdk({ baseUrl: BASE, credential: STATIC, fetch: envelopeStub.fetch });
    const error2 = await sdk2.play("55395830").catch((e) => e as DeliveryError);
    expect(error2.code).toBe("not_playable");
    expect(error2.status).toBe(409);
    expect(error2.message).toBe("媒资尚未就绪");
  });

  it("调用方 signal.aborted → 取消错误不 emit error 事件", async () => {
    const stub = createFetchStub(
      (call) =>
        new Promise<Response>((_, reject) => {
          call.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    );
    const sdk = createPlayerSdk({ baseUrl: BASE, credential: STATIC, fetch: stub.fetch });
    const events: unknown[] = [];
    sdk.on((event) => events.push(event));

    const controller = new AbortController();
    const pending = sdk.listMedia({ signal: controller.signal }).catch((e) => e as DeliveryError);
    controller.abort();
    const error = await pending;
    expect(error.code).toBe("internal");
    expect(events.filter((e) => (e as { type: string }).type === "error")).toHaveLength(0);
  });
});
