// 会话端点（服务端专用，spec.md §11.3）：读预览账号调分发端 login，返回 {access_token, expires_at, delivery_base}。
// 凭据（PLAYER_PREVIEW_*，回退 DELIVERY_PREVIEW_*）**不下发浏览器**；服务端进程内缓存 JWT（过期前 60s 复用）。
// `delivery_base` 为**浏览器**直连分发端的地址（运行时下发，spec.md §11.2）：镜像一次构建跨环境部署，
// 不依赖构建期 NEXT_PUBLIC_* 内联；容器内服务端地址（DELIVERY_BASE_URL）常与浏览器视角地址不同。
import { NextResponse } from "next/server";
import { envValue, stripQuotes } from "@/lib/env";

export const dynamic = "force-dynamic";

const DEFAULT_DELIVERY_BASE_URL = "http://127.0.0.1:9000";

function deliveryBaseUrl(): string {
  return (envValue(process.env.DELIVERY_BASE_URL) || DEFAULT_DELIVERY_BASE_URL).replace(/\/+$/, "");
}

/** 浏览器直连地址：PLAYER_PUBLIC_DELIVERY_BASE_URL → NEXT_PUBLIC_DELIVERY_BASE_URL → 服务端地址 */
function browserDeliveryBaseUrl(): string {
  return (
    envValue(process.env.PLAYER_PUBLIC_DELIVERY_BASE_URL) ||
    envValue(process.env.NEXT_PUBLIC_DELIVERY_BASE_URL) ||
    deliveryBaseUrl()
  ).replace(/\/+$/, "");
}

/** 预览账号：优先 PLAYER_PREVIEW_*，缺省回退管理端预览账号 DELIVERY_PREVIEW_*（spec.md §11.2） */
function previewCredentials(): { username: string; password: string } | null {
  const username = envValue(process.env.PLAYER_PREVIEW_USERNAME) || envValue(process.env.DELIVERY_PREVIEW_USERNAME);
  const password =
    stripQuotes(process.env.PLAYER_PREVIEW_PASSWORD ?? "") ||
    stripQuotes(process.env.DELIVERY_PREVIEW_PASSWORD ?? "");
  if (!username || !password) return null;
  return { username, password };
}

interface CacheEntry {
  accessToken: string;
  expiresAtSec: number;
  /** 凭据 / 分发端地址变更即失效（同一进程多环境切换安全） */
  key: string;
}

let cached: CacheEntry | null = null;

function noStoreJson(body: unknown, status: number): NextResponse {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

export async function GET() {
  const creds = previewCredentials();
  if (!creds) {
    return noStoreJson(
      {
        error: {
          code: "not_implemented",
          message:
            "未配置预览播放账号：请在 env 配置 PLAYER_PREVIEW_USERNAME / PLAYER_PREVIEW_PASSWORD" +
            "（或回退 DELIVERY_PREVIEW_*），账号用 `bun apps/admin/scripts/bootstrap-playback.ts` 创建",
        },
      },
      501,
    );
  }

  const base = deliveryBaseUrl();
  const key = JSON.stringify([base, creds.username, creds.password]);
  const nowSec = Math.floor(Date.now() / 1000);
  if (cached && cached.key === key && cached.expiresAtSec - 60 > nowSec) {
    return noStoreJson(
      {
        access_token: cached.accessToken,
        expires_at: new Date(cached.expiresAtSec * 1000).toISOString(),
        delivery_base: browserDeliveryBaseUrl(),
      },
      200,
    );
  }

  let res: Response;
  try {
    res = await fetch(`${base}/v1/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(creds),
      cache: "no-store",
    });
  } catch (e) {
    return noStoreJson(
      { error: { code: "internal", message: `无法连接分发端（${base}）：${(e as Error).message}` } },
      502,
    );
  }
  const body = (await res.json().catch(() => null)) as
    | { access_token?: string; expires_in?: number; error?: { code?: string; message?: string } }
    | null;
  if (!res.ok || !body?.access_token) {
    return noStoreJson(
      {
        error: {
          code: "internal",
          message: `播放预览账号登录失败（HTTP ${res.status}）：${
            body?.error?.message ?? "请检查账号配置与分发端日志"
          }`,
        },
      },
      502,
    );
  }
  cached = {
    accessToken: body.access_token,
    expiresAtSec: nowSec + (body.expires_in ?? 3600),
    key,
  };
  return noStoreJson(
    {
      access_token: cached.accessToken,
      expires_at: new Date(cached.expiresAtSec * 1000).toISOString(),
      delivery_base: browserDeliveryBaseUrl(),
    },
    200,
  );
}
