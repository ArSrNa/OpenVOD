// 鉴权与生命周期单测（player-sdk-spec.md §12.1：T1~T5 / T18；注入 fetch + 假时钟，无真实网络）
import { afterEach, beforeEach, describe, expect, it, jest } from "bun:test";
import { createPlayerSdk, DeliveryError, type PlayerSdkStorage, type PlayerSdkEvent } from "../src";
import { createFetchStub, errorResponse, jsonResponse, LOGIN_BODY, rejection, type FetchStub } from "./helpers";

const BASE = "https://delivery.test";
const LOGIN = (call: { path: string }) => call.path === "/v1/auth/login";
const LIST = (call: { path: string }) => call.path.startsWith("/v1/media");

const MEDIA_PAGE = {
  items: [{ id: "55395830", title: "演示", poster_url: null, duration_ms: 1000, custom: null }],
  next_cursor: null,
};

function passwordCredential(username = "demo", password = "s3cret") {
  return { mode: "password" as const, username, password };
}

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(new Date("2026-01-01T00:00:00Z"));
});

afterEach(() => {
  jest.useRealTimers();
});

describe("鉴权（§3）", () => {
  it("T1 口令模式 login：请求体 / 头正确；缓存命中零请求", async () => {
    const stub = createFetchStub((call) => {
      if (LOGIN(call)) return jsonResponse(200, LOGIN_BODY);
      if (LIST(call)) return jsonResponse(200, MEDIA_PAGE);
      return errorResponse(404, "not_found", "路由不存在");
    });
    // baseUrl 带尾斜杠 → 规范化去除
    const sdk = createPlayerSdk({ baseUrl: `${BASE}/`, credential: passwordCredential(), fetch: stub.fetch });

    const token = await sdk.auth.getAccessToken();
    expect(token).toBe("jwt-token-1");

    const loginCall = stub.calls[0];
    expect(loginCall.path).toBe("/v1/auth/login");
    expect(loginCall.method).toBe("POST");
    expect(loginCall.headers["content-type"]).toBe("application/json");
    expect(loginCall.body).toEqual({ username: "demo", password: "s3cret" });

    await sdk.auth.getAccessToken();
    expect(stub.count(LOGIN)).toBe(1);

    const page = await sdk.listMedia({ limit: 50 });
    expect(page.items).toHaveLength(1);
    const listCall = stub.calls.at(-1)!;
    expect(listCall.url).toBe(`${BASE}/v1/media?limit=50`);
    expect(listCall.headers.authorization).toBe("Bearer jwt-token-1");
  });

  it("T2 login invalid_credentials：错误保真（code / status / message / hint），配置不清空", async () => {
    const stub = createFetchStub(() => errorResponse(401, "invalid_credentials", "用户名或密码错误"));
    const sdk = createPlayerSdk({ baseUrl: BASE, credential: passwordCredential(), fetch: stub.fetch });

    const error = await rejection(sdk.auth.getAccessToken());
    expect(error).toBeInstanceOf(DeliveryError);
    expect(error.code).toBe("invalid_credentials");
    expect(error.status).toBe(401);
    expect(error.message).toBe("用户名或密码错误");
    expect(typeof error.hint).toBe("string");

    // 凭据未被清空 → 再取仍会尝试登录（宿主改口令后 setCredential 重试）
    await sdk.auth.getAccessToken().catch(() => null);
    expect(stub.count(LOGIN)).toBe(2);
  });

  it("T3 401 兜底：重登一次并重试成功；二次 401 抛错 + auth:changed{expired}", async () => {
    let mediaHits = 0;
    const stub = createFetchStub((call) => {
      if (LOGIN(call)) return jsonResponse(200, LOGIN_BODY);
      mediaHits += 1;
      if (mediaHits === 1) return errorResponse(401, "unauthorized", "未登录或凭证无效");
      return jsonResponse(200, MEDIA_PAGE);
    });
    const events: PlayerSdkEvent[] = [];
    const sdk = createPlayerSdk({ baseUrl: BASE, credential: passwordCredential(), fetch: stub.fetch });
    sdk.on((event) => events.push(event));

    const page = await sdk.listMedia();
    expect(page.items).toHaveLength(1);
    expect(stub.count(LOGIN)).toBe(2); // 首次 login + 401 后重登
    expect(events).toContainEqual({ type: "auth:changed", reason: "refresh" });

    // 二次 401：每请求仅重登一次 → 抛错 + expired
    const stub2 = createFetchStub((call) => {
      if (LOGIN(call)) return jsonResponse(200, LOGIN_BODY);
      return errorResponse(401, "unauthorized", "未登录或凭证无效");
    });
    const events2: PlayerSdkEvent[] = [];
    const sdk2 = createPlayerSdk({ baseUrl: BASE, credential: passwordCredential(), fetch: stub2.fetch });
    sdk2.on((event) => events2.push(event));

    const error = await rejection(sdk2.listMedia());
    expect(error.code).toBe("unauthorized");
    expect(stub2.count(LOGIN)).toBe(2); // 不无限重登
    expect(events2.some((e) => e.type === "auth:changed" && e.reason === "expired")).toBe(true);
  });

  it("T4 JWT 进入 leeway 窗口自动重登（auth:changed{refresh}）", async () => {
    const stub = createFetchStub(() => jsonResponse(200, { ...LOGIN_BODY, expires_in: 100 }));
    const events: PlayerSdkEvent[] = [];
    const sdk = createPlayerSdk({
      baseUrl: BASE,
      credential: passwordCredential(),
      fetch: stub.fetch,
      jwtRefreshLeewaySec: 60,
    });
    sdk.on((event) => events.push(event));

    await sdk.auth.getAccessToken();
    jest.advanceTimersByTime(30_000); // now = t0+30 < 40（100 - 60）→ 新鲜
    await sdk.auth.getAccessToken();
    expect(stub.count(LOGIN)).toBe(1);

    jest.advanceTimersByTime(15_000); // now = t0+45 ≥ 40 → 进入 leeway
    await sdk.auth.getAccessToken();
    expect(stub.count(LOGIN)).toBe(2);
    expect(events).toEqual([
      { type: "auth:changed", reason: "login" },
      { type: "auth:changed", reason: "refresh" },
    ]);
  });

  it("T5 并发去重：10 并发 listMedia 只发生 1 次 login", async () => {
    const stub = createFetchStub((call) => {
      if (LOGIN(call)) return jsonResponse(200, LOGIN_BODY);
      return jsonResponse(200, MEDIA_PAGE);
    });
    const sdk = createPlayerSdk({ baseUrl: BASE, credential: passwordCredential(), fetch: stub.fetch });

    const pages = await Promise.all(Array.from({ length: 10 }, () => sdk.listMedia()));
    expect(pages).toHaveLength(10);
    expect(stub.count(LOGIN)).toBe(1);
    expect(stub.count(LIST)).toBe(10);
  });

  it("static 模式：无重登能力（force / 过期 → 抛错 + expired）", async () => {
    const stub = createFetchStub(() => jsonResponse(200, MEDIA_PAGE));
    const sdk = createPlayerSdk({
      baseUrl: BASE,
      credential: { mode: "static", token: "static-jwt", expires_at: "2026-01-01T01:00:00Z" },
      fetch: stub.fetch,
    });
    const events: PlayerSdkEvent[] = [];
    sdk.on((event) => events.push(event));

    expect(await sdk.auth.getAccessToken()).toBe("static-jwt");

    jest.advanceTimersByTime(3_700_000); // 越过 expires_at（leeway 300s）
    const error = await rejection(sdk.auth.getAccessToken());
    expect(error.code).toBe("unauthorized");
    expect(events.some((e) => e.type === "auth:changed" && e.reason === "expired")).toBe(true);
    expect(stub.count(LOGIN)).toBe(0);
  });

  it("tokenProvider：返回裸 token（TTL 未知）缓存至 401 重取；支持 { access_token, expires_at }", async () => {
    const stub = createFetchStub((call) => {
      if (LIST(call)) {
        return call.headers.authorization === "Bearer tp-2"
          ? jsonResponse(200, MEDIA_PAGE)
          : errorResponse(401, "unauthorized", "未登录或凭证无效");
      }
      return errorResponse(404, "not_found", "路由不存在");
    });
    let issued = 0;
    const sdk = createPlayerSdk({
      baseUrl: BASE,
      credential: {
        mode: "tokenProvider",
        getToken: () => {
          issued += 1;
          return issued === 1 ? "tp-1" : { access_token: "tp-2", expires_at: "2026-01-01T02:00:00Z" };
        },
      },
      fetch: stub.fetch,
    });

    // 第一次请求：tp-1 → 401 → 强制重取 tp-2 → 重试成功
    const page = await sdk.listMedia();
    expect(page.items).toHaveLength(1);
    expect(issued).toBe(2);
    expect(stub.count(LOGIN)).toBe(0); // tokenProvider 模式不发 login 请求
  });
});

describe("storage 注入（§3.4 / T18）", () => {
  function memoryStorage(): { storage: PlayerSdkStorage; map: Map<string, string> } {
    const map = new Map<string, string>();
    return {
      map,
      storage: {
        get: (key) => map.get(key) ?? null,
        set: (key, value) => {
          map.set(key, value);
        },
        remove: (key) => {
          map.delete(key);
        },
      },
    };
  }

  it("T18 写 / 读 / 切换身份清除 / 脏数据丢弃重登", async () => {
    const { storage, map } = memoryStorage();
    const KEY = "openvod.player-sdk.token";

    const stub1 = createFetchStub((call) => {
      if (LOGIN(call)) return jsonResponse(200, LOGIN_BODY);
      return jsonResponse(200, MEDIA_PAGE);
    });
    const sdk1 = createPlayerSdk({ baseUrl: BASE, credential: passwordCredential(), fetch: stub1.fetch, storage });
    await sdk1.listMedia();
    expect(stub1.count(LOGIN)).toBe(1);
    expect(JSON.parse(map.get(KEY)!)).toMatchObject({ access_token: "jwt-token-1", identity: "password:demo" });

    // 新实例共享 storage：命中持久化 token → 零 login
    const stub2 = createFetchStub((call) => {
      if (LOGIN(call)) return jsonResponse(200, LOGIN_BODY);
      return jsonResponse(200, MEDIA_PAGE);
    });
    const sdk2 = createPlayerSdk({ baseUrl: BASE, credential: passwordCredential(), fetch: stub2.fetch, storage });
    await sdk2.listMedia();
    expect(stub2.count(LOGIN)).toBe(0);

    // 身份切换 → 清除旧值 + 事件 switched
    const events: PlayerSdkEvent[] = [];
    sdk2.on((event) => events.push(event));
    sdk2.auth.setCredential(passwordCredential("other", "pw-123456"));
    expect(map.has(KEY)).toBe(false);
    expect(events).toContainEqual({ type: "auth:changed", reason: "switched" });

    // 脏数据 → 丢弃并重登
    map.set(KEY, "{not-json");
    const stub3 = createFetchStub((call) => {
      if (LOGIN(call)) return jsonResponse(200, LOGIN_BODY);
      return jsonResponse(200, MEDIA_PAGE);
    });
    const sdk3 = createPlayerSdk({ baseUrl: BASE, credential: passwordCredential(), fetch: stub3.fetch, storage });
    await sdk3.listMedia();
    expect(stub3.count(LOGIN)).toBe(1);
  });
});
