import { describe, expect, it } from "bun:test";
import { checkDeliveryDeployment, waitForDeliveryReady } from "./check-delivery-deployment";

function deliveryResponse(url: string): Response {
  const path = new URL(url).pathname;
  if (path.endsWith("/healthz")) return Response.json({ app: "delivery", status: "ok" });
  const isMediaList = path.endsWith("/v1/media");
  return Response.json({ error: { code: isMediaList ? "unauthorized" : "bad_token" } }, {
    status: isMediaList ? 401 : 403,
  });
}

describe("delivery 部署门禁", () => {
  it("验证所有公开路由，并保持无凭据、无签名和不跟随重定向", async () => {
    const paths: string[] = [];
    const results = await checkDeliveryDeployment("https://delivery.example.com/", {
      fetcher: async (url, init) => {
        const parsed = new URL(url);
        paths.push(parsed.pathname);
        expect(parsed.search).toBe("");
        expect(init.method).toBe("GET");
        expect(init.redirect).toBe("manual");
        expect(init.signal).toBeInstanceOf(AbortSignal);
        const headers = new Headers(init.headers);
        expect(headers.has("authorization")).toBe(false);
        expect(headers.has("cookie")).toBe(false);
        expect(headers.has("x-playback-token")).toBe(false);
        return deliveryResponse(url);
      },
    });
    expect(results).toHaveLength(6);
    expect(results.every((result) => result.ok)).toBe(true);
    expect(paths).toEqual([
      "/healthz",
      "/v1/media/00000000/manifest/master.m3u8",
      "/v1/media/00000000/manifest/720p/index.m3u8",
      "/v1/media/00000000/key",
      "/v1/media/00000000/subtitles/c0000000000000000000000000.vtt",
      "/v1/media",
    ]);
  });

  it("平台 HTML 404 提示检查部署和路由，且不泄露正文", async () => {
    const results = await checkDeliveryDeployment("https://delivery.example.com", {
      fetcher: async () => new Response("<html>private-response-value</html>", {
        status: 404,
        headers: { "content-type": "text/html; charset=utf-8" },
      }),
    });
    expect(results.every((result) => !result.ok && result.detail.includes("生产部署") && result.detail.includes("路由"))).toBe(true);
    expect(JSON.stringify(results)).not.toContain("private-response-value");
  });

  it("拒绝重定向，也不输出 Location", async () => {
    let requests = 0;
    const results = await checkDeliveryDeployment("https://delivery.example.com", {
      fetcher: async () => {
        requests++;
        return new Response(null, { status: 302, headers: { Location: "https://example.com/?secret=private-value" } });
      },
    });
    expect(requests).toBe(6);
    expect(results.every((result) => !result.ok && result.detail.includes("未跟随"))).toBe(true);
    expect(JSON.stringify(results)).not.toContain("private-value");
  });

  it("相同状态码的其他服务或错误码不能通过", async () => {
    const results = await checkDeliveryDeployment("https://delivery.example.com", {
      fetcher: async (url) => url.endsWith("/healthz")
        ? Response.json({ app: "admin", status: "ok" })
        : Response.json({ error: { code: "forbidden", message: "private-message" } }, { status: url.endsWith("/v1/media") ? 401 : 403 }),
    });
    expect(results.every((result) => !result.ok)).toBe(true);
    expect(results[0].detail).toContain("app=delivery");
    expect(results[1].detail).toContain("bad_token");
    expect(JSON.stringify(results)).not.toContain("private-message");
  });

  it("拒绝把登录页或 SPA 的 200 误认为播放鉴权成功", async () => {
    const results = await checkDeliveryDeployment("https://delivery.example.com", {
      fetcher: async (url) => url.endsWith("/healthz") ? deliveryResponse(url) : Response.json({ ok: true }),
    });
    expect(results[0].ok).toBe(true);
    expect(results.slice(1).every((result) => !result.ok)).toBe(true);
  });

  it("超时中止请求且不会重试", async () => {
    let requests = 0;
    const results = await checkDeliveryDeployment("https://delivery.example.com", {
      timeoutMs: 5,
      fetcher: async (_url, init) => {
        requests++;
        return new Promise((_resolve, reject) => init.signal!.addEventListener("abort", () => reject(new Error("private-error")), { once: true }));
      },
    });
    expect(requests).toBe(6);
    expect(results.every((result) => !result.ok && result.detail.includes("超过 5ms"))).toBe(true);
    expect(JSON.stringify(results)).not.toContain("private-error");
  });

  it("响应体读取也受超时限制", async () => {
    const results = await checkDeliveryDeployment("https://delivery.example.com", {
      timeoutMs: 5,
      fetcher: async (url, init) => url.endsWith("/healthz")
        ? new Response(new ReadableStream({
          start(controller) {
            init.signal!.addEventListener("abort", () => controller.error(new Error("private-error")), { once: true });
          },
        }), { headers: { "content-type": "application/json" } })
        : deliveryResponse(url),
    });
    expect(results[0].ok).toBe(false);
    expect(results[0].detail).toContain("超过 5ms");
    expect(results.slice(1).every((result) => result.ok)).toBe(true);
  });

  it("无效或过大的 JSON 失败，网络异常也不转储错误文本", async () => {
    for (const mode of ["invalid", "large", "network"]) {
      const results = await checkDeliveryDeployment("https://delivery.example.com", {
        fetcher: async (url) => {
          if (!url.endsWith("/healthz")) return deliveryResponse(url);
          if (mode === "network") throw new Error("private-network-error");
          return new Response(mode === "large" ? '"' + "x".repeat(65 * 1024) + '"' : "private-invalid-json", {
            headers: { "content-type": "application/json" },
          });
        },
      });
      expect(results[0].ok).toBe(false);
      expect(results.slice(1).every((result) => result.ok)).toBe(true);
      expect(JSON.stringify(results)).not.toContain("private-");
    }
  });

  it("拒绝带凭据或 token 的 base URL，避免把秘密写入错误文本", async () => {
    for (const base of [
      "not-a-url-private-secret",
      "file:///private-secret",
      "https://user:private-secret@example.com",
      "https://example.com?t=private-secret",
      "https://example.com#private-secret",
    ]) {
      let calls = 0;
      const promise = checkDeliveryDeployment(base, { fetcher: async (url) => { calls++; return deliveryResponse(url); } });
      await expect(promise).rejects.toThrow("base URL");
      try { await promise; } catch (error) { expect(String(error)).not.toContain("private-secret"); }
      expect(calls).toBe(0);
    }
  });
});

describe("delivery 冷启动就绪等待", () => {
  it("只预热 healthz，超时及平台 503 后恢复时通过", async () => {
    let calls = 0;
    const retries: number[] = [];
    const result = await waitForDeliveryReady("https://delivery.example.com", {
      timeoutMs: 10, readyTimeoutMs: 300, retryDelayMs: 1,
      onRetry: (attempt) => retries.push(attempt),
      fetcher: async (url, init) => {
        expect(new URL(url).pathname).toBe("/healthz");
        calls++;
        if (calls === 1) return new Promise((_resolve, reject) => init.signal!.addEventListener("abort", () => reject(new Error("timeout")), { once: true }));
        if (calls === 2) return new Response("not ready", { status: 503 });
        return deliveryResponse(url);
      },
    });
    expect(result.ok).toBe(true);
    expect(calls).toBe(3);
    expect(retries).toEqual([1, 2]);
  });

  it("部署切换暂时出现平台 404 时允许在窗口内恢复", async () => {
    let calls = 0;
    const result = await waitForDeliveryReady("https://delivery.example.com", {
      readyTimeoutMs: 100, retryDelayMs: 1,
      fetcher: async (url) => ++calls === 1
        ? new Response("not ready", { status: 404, headers: { "content-type": "text/html" } })
        : deliveryResponse(url),
    });
    expect(result.ok).toBe(true);
    expect(calls).toBe(2);
  });

  it("持续故障在总预算到期后失败，不无限重试", async () => {
    let calls = 0;
    const start = Date.now();
    const result = await waitForDeliveryReady("https://delivery.example.com", {
      timeoutMs: 1000, readyTimeoutMs: 20, retryDelayMs: 1,
      fetcher: async (_url, init) => {
        calls++;
        return new Promise((_resolve, reject) => init.signal!.addEventListener("abort", () => reject(new Error("timeout")), { once: true }));
      },
    });
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("20ms 窗口");
    expect(calls).toBe(1);
    expect(Date.now() - start).toBeLessThan(500);
  });

  it("重定向或另一个服务的健康响应立即失败，不掩盖配置错误", async () => {
    for (const response of [() => new Response(null, { status: 302 }), () => Response.json({ app: "admin", status: "ok" })]) {
      let calls = 0;
      const result = await waitForDeliveryReady("https://delivery.example.com", {
        fetcher: async () => { calls++; return response(); },
      });
      expect(result.ok).toBe(false);
      expect(calls).toBe(1);
    }
  });
});
