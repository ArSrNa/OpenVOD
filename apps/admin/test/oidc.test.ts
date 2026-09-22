// OIDC provider 解析单测（apps/admin/src/lib/oidc.ts）
//
// 锁住的核心事实：**未配置 issuer 时零触网**（不发请求、不引入等待），已配置时才做带超时的 discovery
// 预检，且预检失败一律降级为空（不抛错、不阻塞本地邮箱密码登录）。
// 背景：better-auth 自身的 discovery 无超时且落在每个控制台页面请求的会话校验路径上，实测可挂 132s。
import { describe, expect, it } from "bun:test";
import { resolveOidcProviders, type OidcResolveDeps } from "../src/lib/oidc";

const DISCOVERY_DOC = {
  issuer: "https://idp.example.com",
  authorization_endpoint: "https://idp.example.com/authorize",
  token_endpoint: "https://idp.example.com/token",
  jwks_uri: "https://idp.example.com/jwks",
};

/** 记录调用的假 fetch：单测只关心「有没有发请求 / 发了什么 / 返回如何」 */
function stubFetch(respond: () => Response | Promise<Response>) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return respond();
  }) as unknown as typeof fetch;
  return { impl, calls };
}

function collectLogs() {
  const lines: string[] = [];
  const log = (_level: "info" | "error", message: string) => {
    lines.push(message);
  };
  return { lines, log };
}

function settings(overrides: Partial<Parameters<typeof resolveOidcProviders>[0]> = {}) {
  return { issuer: "", clientId: "", clientSecret: "", ...overrides };
}

function deps(fetchImpl: typeof fetch, log?: OidcResolveDeps["log"]): OidcResolveDeps {
  return { fetchImpl, log, now: () => 0 };
}

describe("resolveOidcProviders：未配置 → 零触网", () => {
  it("issuer 为空：立即返回空数组，且**一次请求都不发**", async () => {
    const { impl, calls } = stubFetch(() => {
      throw new Error("未配置时不应触网");
    });
    const { lines, log } = collectLogs();
    const providers = await resolveOidcProviders(settings(), deps(impl, log));

    expect(providers).toEqual([]);
    expect(calls).toHaveLength(0);
    expect(lines.some((l) => l.includes("OIDC 未配置"))).toBe(true);
  });

  it("issuer 只有空白字符：同样视为未配置（不触网）", async () => {
    const { impl, calls } = stubFetch(() => {
      throw new Error("未配置时不应触网");
    });
    const providers = await resolveOidcProviders(settings({ issuer: "   " }), deps(impl));
    expect(providers).toEqual([]);
    expect(calls).toHaveLength(0);
  });
});

describe("resolveOidcProviders：已配置 → 带超时预检", () => {
  it("discovery 可达且文档完整：注册 generic-oidc，结尾斜杠已归一化", async () => {
    const { impl, calls } = stubFetch(() => Response.json(DISCOVERY_DOC));
    const providers = await resolveOidcProviders(
      settings({ issuer: "https://idp.example.com/", clientId: "cid", clientSecret: "sec" }),
      deps(impl),
    );

    expect(calls[0]?.url).toBe("https://idp.example.com/.well-known/openid-configuration");
    expect(providers).toHaveLength(1);
    expect(providers[0]).toMatchObject({
      providerId: "generic-oidc",
      clientId: "cid",
      clientSecret: "sec",
      scopes: ["openid", "profile", "email"],
      pkce: true,
    });
    // 保留 discoveryUrl：better-auth 仍需据此装配 id_token 校验（issuer / jwks_uri）
    expect(providers[0]?.discoveryUrl).toBe("https://idp.example.com/.well-known/openid-configuration");
  });

  it("预检请求带超时上限（AbortSignal），不再是无超时的 betterFetch", async () => {
    const { impl, calls } = stubFetch(() => Response.json(DISCOVERY_DOC));
    await resolveOidcProviders(settings({ issuer: "https://idp.example.com" }), deps(impl));
    expect(calls[0]?.init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("网络异常 / 超时：降级为空并记录原因，不向外抛", async () => {
    const { impl } = stubFetch(() => {
      throw new Error("The operation timed out.");
    });
    const { lines, log } = collectLogs();
    const providers = await resolveOidcProviders(
      settings({ issuer: "https://idp.example.com" }),
      deps(impl, log),
    );

    expect(providers).toEqual([]);
    expect(lines.some((l) => l.includes("预检失败") && l.includes("timed out"))).toBe(true);
  });

  it("非 2xx：降级为空", async () => {
    const { impl } = stubFetch(() => new Response("bad gateway", { status: 502 }));
    const { lines, log } = collectLogs();
    const providers = await resolveOidcProviders(
      settings({ issuer: "https://idp.example.com" }),
      deps(impl, log),
    );

    expect(providers).toEqual([]);
    expect(lines.some((l) => l.includes("HTTP 502"))).toBe(true);
  });

  it("文档缺少 authorization_endpoint / token_endpoint：降级为空", async () => {
    const { impl } = stubFetch(() => Response.json({ issuer: "https://idp.example.com" }));
    const { lines, log } = collectLogs();
    const providers = await resolveOidcProviders(
      settings({ issuer: "https://idp.example.com" }),
      deps(impl, log),
    );

    expect(providers).toEqual([]);
    expect(lines.some((l) => l.includes("缺少 authorization_endpoint"))).toBe(true);
  });
});
