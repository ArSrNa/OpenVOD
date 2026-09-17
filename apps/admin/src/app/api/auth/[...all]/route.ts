// better-auth 全量路由挂载（ADR-0013）：
//   /api/auth/sign-in/email、/api/auth/sign-out、/api/auth/get-session、
//   /api/auth/signin/social、/api/auth/oauth2/callback/generic-oidc ...
import { toNextJsHandler } from "better-auth/next-js";
import { auth } from "@/lib/auth";

export const { GET, POST } = toNextJsHandler(auth.handler);
