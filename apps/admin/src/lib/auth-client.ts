// better-auth 前端客户端（React hooks）
// 注：better-auth 1.7+ 中 genericOAuth 服务端插件将自定义提供方注册为一等 social provider，
// 客户端无需额外插件，直接 signIn.social({ provider: "generic-oidc" })。
import { createAuthClient } from "better-auth/react";

export const authClient = createAuthClient({});

export const GENERIC_OIDC_PROVIDER_ID = "generic-oidc";
