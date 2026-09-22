// OIDC（genericOAuth）provider 解析：纯逻辑 + 依赖可注入，单测见 apps/admin/test/oidc.test.ts。
//
// 为什么单独成文件（而不是在 auth.ts 里写一个三元表达式）：better-auth 的 genericOAuth 在**插件 init**
// 里用 betterFetch 抓 `${issuer}/.well-known/openid-configuration`——**没有超时**，而插件 init 落在
// `auth.api.getSession()` 的首次调用路径上，也就是 `requireConsoleSession()`，即**每个控制台页面请求**。
// IdP 不可达 / 出口网络抖动时，控制台会被一路拖到 TCP 超时（实测 132s；客户端 / 网关约 60s 先放弃 →
// 「GET /xxx 200 in 60s」+「The destination stream closed early」+「discovery left no usable ...」）。
// 因此注册 provider 之前先由本模块带超时预检一次：
//
//   - **未配置 issuer**（`system_settings.admin_oidc_issuer` 与 env `OIDC_ISSUER` 皆空）→ 立即返回空数组：
//     **不发任何请求、不引入任何等待**——未配置就不该有代价（ADR-0012 双轨：SSO 是可选轨）；
//   - 预检失败（超时 / 非 2xx / 文档不可用）→ 本次实例不注册 SSO，本地邮箱密码登录不受影响
//     （spec.md §2.1 渐进降级：读取失败一律回退，不阻塞业务）；
//   - 预检通过 → 返回 provider 配置。better-auth 自身那次 discovery 复用刚建立的连接（毫秒级），
//     保留 `discoveryUrl` 是为了让 id_token 校验（issuer / jwks_uri）仍由 better-auth 自行装配。

/** genericOAuth 的 provider 配置（结构性对齐 better-auth，避免直接依赖其内部类型） */
export interface OidcProviderConfig {
  providerId: string;
  discoveryUrl: string;
  clientId: string;
  clientSecret: string;
  scopes: string[];
  pkce: boolean;
}

export interface OidcSettingsInput {
  /** issuer（调用方已按「settings 覆盖 env」解析好的最终值；空串 = 未配置） */
  issuer: string;
  clientId: string;
  clientSecret: string;
}

export interface OidcResolveDeps {
  /** provider id（默认 generic-oidc，与前端 GENERIC_OIDC_PROVIDER_ID 对齐） */
  providerId?: string;
  /** 预检超时上限（默认 3s；只在「已配置」路径下才可能等待） */
  timeoutMs?: number;
  /** 注入点（单测传假实现；默认 globalThis.fetch） */
  fetchImpl?: typeof fetch;
  /** 注入点（单测控制耗时统计；默认 Date.now） */
  now?: () => number;
  /** 注入点（单测断言日志；默认 console） */
  log?: (level: "info" | "error", message: string) => void;
}

export const DEFAULT_OIDC_DISCOVERY_TIMEOUT_MS = 3000;

/** 解析 OIDC provider 列表：未配置 → 零触网返回空；已配置 → 带超时预检，失败降级为空（永不抛错） */
export async function resolveOidcProviders(
  settings: OidcSettingsInput,
  deps: OidcResolveDeps = {},
): Promise<OidcProviderConfig[]> {
  const log =
    deps.log ??
    ((level: "info" | "error", message: string) =>
      level === "error" ? console.error(message) : console.log(message));

  const issuer = settings.issuer.trim().replace(/\/+$/, "");
  if (!issuer) {
    // 未配置：到此为止。不构造 URL、不 fetch、不等任何东西（含超时计时）。
    log("info", "[admin] OIDC 未配置（admin_oidc_issuer / OIDC_ISSUER 皆空）→ 不注册 SSO，仅本地邮箱密码登录");
    return [];
  }

  const providerId = deps.providerId ?? "generic-oidc";
  const discoveryUrl = `${issuer}/.well-known/openid-configuration`;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_OIDC_DISCOVERY_TIMEOUT_MS;
  const now = deps.now ?? Date.now;
  const startedAt = now();

  try {
    const res = await (deps.fetchImpl ?? fetch)(discoveryUrl, {
      headers: { accept: "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const doc = (await res.json()) as { authorization_endpoint?: string; token_endpoint?: string };
    if (!doc?.authorization_endpoint || !doc?.token_endpoint) {
      throw new Error("discovery 文档缺少 authorization_endpoint / token_endpoint");
    }
    log("info", `[admin] OIDC discovery 预检通过（${issuer}，${now() - startedAt}ms）`);
    return [
      {
        providerId,
        discoveryUrl,
        clientId: settings.clientId,
        clientSecret: settings.clientSecret,
        scopes: ["openid", "profile", "email"],
        pkce: true,
      },
    ];
  } catch (e) {
    log(
      "error",
      `[admin] OIDC discovery 预检失败（${discoveryUrl}，${now() - startedAt}ms，上限 ${timeoutMs}ms）：` +
        `${(e as Error).message}。本次实例不注册 ${providerId}：SSO 登录暂不可用，本地邮箱密码登录不受影响；` +
        "请核对 admin_oidc_issuer（或 OIDC_ISSUER）与容器出口网络。",
    );
    return [];
  }
}
