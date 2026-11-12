// 会话端点（服务端专用，spec.md §11.3）：读预览账号调分发端 login，返回 {access_token, expires_at}。
// 凭据（PLAYER_PREVIEW_*，回退 DELIVERY_PREVIEW_*）**不下发浏览器**；服务端进程内缓存 JWT（过期前 60s 复用）。
// 自 2026-11-12（spec.md §11.9）起不再下发 `delivery_base`：浏览器的分发端请求一律经 /api/delivery 同源代理，
// 分发端真实地址只在服务端 env（DELIVERY_BASE_URL）——镜像一次构建跨环境部署的语义不变，且更彻底。
import { NextResponse } from "next/server";

import { deliveryBaseUrl, previewCredentials } from "@/lib/delivery-server";

export const dynamic = "force-dynamic";

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
    return noStoreJson({ access_token: cached.accessToken, expires_at: new Date(cached.expiresAtSec * 1000).toISOString() }, 200);
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
    // 分发端地址（可能是回源内网 / 源站 IP）只在服务端日志里出现
    console.error("[player] 无法连接分发端:", base, e);
    return noStoreJson(
      { error: { code: "internal", message: "无法连接分发端，请检查服务端 DELIVERY_BASE_URL" } },
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
    { access_token: cached.accessToken, expires_at: new Date(cached.expiresAtSec * 1000).toISOString() },
    200,
  );
}
