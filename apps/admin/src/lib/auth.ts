// better-auth 服务端实例（ADR-0013：Prisma adapter + genericOAuth，双轨账号）
// ADR-0015：改为惰性初始化（getAuth()）——启动只依赖 DATABASE_URL + MASTER_KEYS（env），
// 会话密钥 / 基址 / OIDC 等在首次请求时从 system_settings 解封读取（env 兜底），
// 从而支持「首次启动向导」：未跑 /setup 前不要求配置 BETTER_AUTH_SECRET。
import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { genericOAuth } from "better-auth/plugins";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { currentProvider, getDb } from "@openvod/db";
import { clientIp, recordLoginAudit } from "./audit";
import { resolveOidcProviders } from "./oidc";
import { getSettingsSnapshot, resolveSecret } from "./settings";

const adminPort = process.env.ADMIN_PORT ?? process.env.PORT ?? 8787;

/**
 * CNB 运行环境识别：云原生开发/WebIDE 注入 CNB_VSCODE_PROXY_URI
 * （形如 https://wy8gx4ck6i-{{port}}.cnb.run），把 {{port}} 换成 ADMIN_PORT
 * 即管理端的对外访问基址。检测到即以它**覆盖**基址与信任来源（CNB 端口映射固定，
 * 无需手工维护；平台注入值优先于 system_settings / env）。
 */
function resolveCnbBaseURL(): string | undefined {
  const proxyUri = process.env.CNB_VSCODE_PROXY_URI?.trim();
  if (!proxyUri) return undefined;
  return proxyUri.replace(/\{\{port\}\}/gi, String(adminPort)).replace(/\/+$/, "");
}

const cnbBaseURL = resolveCnbBaseURL();
if (cnbBaseURL) {
  process.env.ADMIN_BASE_URL = cnbBaseURL;
  process.env.ADMIN_TRUSTED_ORIGINS = cnbBaseURL;
}

/**
 * trustedOrigins 归一化：better-auth 对不含通配符的条目按 `pattern === origin` 全量比对，
 * origin 带协议，因此裸域名（CNB 预览域、内网反代域名这类习惯写法）永远匹配不上 —— 裸域名展开成两条。
 *
 * 另外必须信任 baseURL 的 **http 等同体**：CNB 预览域网关会在转发时把 `Origin` 重写成
 * `http://<目标域名>`（已实测：任意 Origin 都会被改写），而 baseURL 是 https，
 * 不补这一条则登录恒报 403 `Invalid origin: http://...`（与浏览器用的是不是 https 无关）。
 */
function normalizeTrustedOrigins(raw: string | undefined, baseURL: string): string[] {
  const list = (raw ?? "")
    .split(",")
    .map((entry) => entry.trim().replace(/\/+$/, ""))
    .filter(Boolean)
    .flatMap((entry) =>
      entry.includes("://") ? [entry] : [`http://${entry}`, `https://${entry}`],
    );
  const httpTwin = baseURL.replace(/^https:\/\//, "http://");
  return list.includes(httpTwin) ? list : [...list, httpTwin];
}

async function buildAuth() {
  const prisma = getDb<any>();
  // 设置快照（30s 缓存）：基址 / 信任来源 / 会话 TTL / OIDC 皆为明文键
  const snap = await getSettingsSnapshot().catch(() => null);
  const secret = await resolveSecret("better_auth_secret");
  if (!secret) {
    throw new Error(
      "管理端会话密钥未配置：请完成首次启动向导（/setup）或设置环境变量 BETTER_AUTH_SECRET",
    );
  }

  // 基址优先级：CNB 平台注入 > system_settings.admin_base_url > env > localhost
  const adminBaseURL =
    cnbBaseURL ||
    snap?.admin.baseUrl ||
    process.env.ADMIN_BASE_URL?.trim() ||
    `http://localhost:${adminPort}`;

  // 通用 OIDC（ADR-0012 决策保留）：未配置 issuer → 零触网、零等待地不注册 SSO；
  // 已配置 → 带超时预检后再注册。判定与降级语义集中在 lib/oidc（含单测），见其顶部注释。
  const oidcConfig = await resolveOidcProviders({
    issuer: snap?.admin.oidcIssuer || "",
    clientId: snap?.admin.oidcClientId || "",
    clientSecret: snap?.admin.oidcClientSecret || "",
  });

  return betterAuth({
    baseURL: adminBaseURL,
    secret,
    trustedOrigins: normalizeTrustedOrigins(
      snap?.admin.trustedOrigins ?? process.env.ADMIN_TRUSTED_ORIGINS,
      adminBaseURL,
    ),
    advanced: {
      // 网关（CNB 预览域）TLS 终止后回源是 http：开启后 better-auth 按 x-forwarded-host/proto
      // 推导 origin，否则浏览器未带 Origin（预览面板沙箱 iframe 发 Origin: null + Sec-Fetch-Site:
      // same-origin）时会推出 http://<host>，与 https 的 baseURL 不匹配而 403。前提：必须在网关后部署。
      trustedProxyHeaders: true,
    },
    // better-auth 1.7 prismaAdapter 与 PrismaClient 泛型联合推断过深，此处断言（运行时无影响）
    database: prismaAdapter(prisma, { provider: currentProvider() }) as any,
    emailAndPassword: {
      enabled: true, // 本地兜底账号（双轨，ADR-0012 §3）
      minPasswordLength: 8,
    },
    session: {
      modelName: "adminSession",
      expiresIn: snap?.admin.sessionTtlSec ?? 8 * 3600,
      updateAge: 3600, // 每小时滚动续期
    },
    user: {
      modelName: "adminUser",
      additionalFields: {
        username: { type: "string", required: false, input: false },
      },
    },
    account: { modelName: "adminAccount" },
    verification: { modelName: "adminVerification" },
    // 登录事件审计（ADR-0012 §3）：本地 / OAuth 成败均落 audit_logs
    hooks: {
      after: createAuthMiddleware(async (ctx) => {
        const isLocal = ctx.path === "/sign-in/email";
        const OAUTH_CB = "/callback/"; // 1.7.x genericOAuth 回调：/api/auth/callback/<providerId>
        const isOAuthCb = ctx.path.startsWith(OAUTH_CB);
        if (!isLocal && !isOAuthCb) return; // SSO 发起（/sign-in/social）不算登录结果

        const ip = clientIp(ctx.headers);
        // 回调为参数化路由，ctx.path 是模板（/callback/:id），真实 providerId 在 params
        const provider = isLocal
          ? "local"
          : ((ctx as any).params?.id as string | undefined) ??
            ctx.path.slice(OAUTH_CB.length);
        const newSession = (ctx.context as any).newSession as
          | { user?: { id?: string; email?: string }; session?: { userId?: string } }
          | null
          | undefined;

        if (newSession) {
          await recordLoginAudit({
            actorType: "admin_user",
            actorId: String(newSession.user?.id ?? newSession.session?.userId ?? ""),
            action: "console.login",
            target: newSession.user?.email ?? null,
            detail: { provider },
            ip,
          });
          return;
        }

        // 失败：returned 为 APIError（本地口令错误 / IdP 拒绝）或重定向 Response
        const returned = (ctx.context as any).returned;
        const reason =
          returned instanceof APIError
            ? returned.message
            : returned instanceof Response
              ? `http_${returned.status}`
              : "unknown";
        const email = ((ctx as any).body?.email as string | undefined) ?? null;
        await recordLoginAudit({
          actorType: "anonymous",
          actorId: email ?? "unknown",
          action: "console.login_failed",
          target: email,
          detail: { provider, reason },
          ip,
        });
      }),
    },
    plugins: oidcConfig.length ? [genericOAuth({ config: oidcConfig })] : [],
  });
}

let instance: Awaited<ReturnType<typeof buildAuth>> | null = null;
let building: Promise<Awaited<ReturnType<typeof buildAuth>>> | null = null;

export type AuthInstance = Awaited<ReturnType<typeof buildAuth>>;

/** 惰性获取 better-auth 实例（进程内单例；首次调用从 system_settings 解封会话密钥） */
export function getAuth(): Promise<AuthInstance> {
  if (instance) return Promise.resolve(instance);
  building ??= buildAuth().then((a) => {
    instance = a;
    return a;
  });
  return building;
}
