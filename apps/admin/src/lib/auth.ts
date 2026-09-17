// better-auth 服务端实例（ADR-0013：Prisma adapter + genericOAuth，双轨账号）
import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { genericOAuth } from "better-auth/plugins";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { currentProvider, getDb } from "@openvod/db";
import { clientIp, recordLoginAudit } from "./audit";

const adminPort = process.env.ADMIN_PORT ?? process.env.PORT ?? 8787;

const prisma = getDb<any>();

// 通用 OIDC（ADR-0012 决策保留）：不配 OIDC_ISSUER 则仅本地邮箱密码登录
const oidcConfig = process.env.OIDC_ISSUER
  ? [
      {
        providerId: "generic-oidc",
        discoveryUrl: `${process.env.OIDC_ISSUER.replace(/\/+$/, "")}/.well-known/openid-configuration`,
        clientId: process.env.OIDC_CLIENT_ID ?? "",
        clientSecret: process.env.OIDC_CLIENT_SECRET ?? "",
        scopes: ["openid", "profile", "email"],
        pkce: true,
      },
    ]
  : [];

export const auth = betterAuth({
  baseURL: process.env.ADMIN_BASE_URL ?? `http://localhost:${adminPort}`,
  secret: process.env.BETTER_AUTH_SECRET,
  trustedOrigins: (process.env.ADMIN_TRUSTED_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  // better-auth 1.7 prismaAdapter 与 PrismaClient 泛型联合推断过深，此处断言（运行时无影响）
  database: prismaAdapter(prisma, { provider: currentProvider() }) as any,
  emailAndPassword: {
    enabled: true, // 本地兜底账号（双轨，ADR-0012 §3）
    minPasswordLength: 8,
  },
  session: {
    modelName: "adminSession",
    expiresIn: Number(process.env.ADMIN_SESSION_TTL_SEC ?? 8 * 3600),
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
