// /api/delivery/**：分发端同源代理（spec.md §11.9，2026-11-12）
//
// 浏览器的**所有**分发端请求都走这里：业务 API（媒体列表 / 详情 / play）、HLS 主 / 子清单、密钥、
// 字幕 VTT，以及浏览器不可达地址上的分片（本地 RustFS 等开发形态）。
//
// 为什么必须代理：浏览器视角的 `127.0.0.1` 是**用户自己的机器**——player 经端口预览（CNB 网关）打开时，
// 浏览器永远连不上容器内的 `DELIVERY_BASE_URL`。改为服务端代理后，前端只与 player 同源通信，
// 分发端地址（含容器内 127.0.0.1）只存在于服务端 env。
//
// 字节取向：公网对象存储 / CDN 的分片 URL 不会被改写（`toProxyPath` 返回 null），仍由浏览器直连；
// 只有回环 / 私有网段地址才经代理转发（体验环境形态，非生产路径）。
import { NextRequest, NextResponse } from "next/server";

import { deliveryBaseUrl, rewritePlaylist, rewritePlayResponse } from "@/lib/delivery-server";

export const dynamic = "force-dynamic";

/** 透传给分发端的请求头（只放必要项；`accept-encoding` 由 fetch 自行协商） */
const FORWARD_REQUEST_HEADERS = ["authorization", "content-type", "accept", "range", "if-range", "if-none-match"];
/** 透传回浏览器的响应头（分片 Range 播放 / 缓存校验需要） */
const FORWARD_RESPONSE_HEADERS = ["content-type", "content-length", "content-range", "accept-ranges", "etag", "last-modified"];

const PLAY_PATH = /^v1\/media\/[^/]+\/play$/;

type Ctx = { params: Promise<{ path?: string[] }> };

function noStore(headers: Headers): Headers {
  headers.set("Cache-Control", "no-store");
  return headers;
}

function proxyError(message: string): NextResponse {
  return NextResponse.json(
    { error: { code: "internal", message } },
    { status: 502, headers: { "Cache-Control": "no-store" } },
  );
}

async function proxy(req: NextRequest, ctx: Ctx): Promise<Response> {
  const { path = [] } = await ctx.params;
  const segments = path.map((segment) => encodeURIComponent(segment));
  const base = deliveryBaseUrl();
  const method = req.method.toUpperCase();

  let target: URL;
  try {
    target = new URL(`${base}/${segments.join("/")}`);
  } catch {
    // 不回显 base：分发端地址（回源地址 / IP）只允许存在于服务端，不能经浏览器可见的响应体泄露
    console.error("[player] DELIVERY_BASE_URL 不是合法地址:", base);
    return proxyError("分发端地址配置非法（DELIVERY_BASE_URL），请检查服务端 env");
  }
  target.search = req.nextUrl.search;

  const headers = new Headers();
  for (const name of FORWARD_REQUEST_HEADERS) {
    const value = req.headers.get(name);
    if (value) headers.set(name, value);
  }

  let upstream: Response;
  try {
    upstream = await fetch(target, {
      method,
      headers,
      body: method === "GET" || method === "HEAD" ? undefined : await req.arrayBuffer(),
      cache: "no-store",
      redirect: "manual",
    });
  } catch (e) {
    // 同上：异常详情（可能含源站地址）只进服务端日志，响应体只给通用提示
    console.error("[player] 无法连接分发端:", base, e);
    return proxyError("无法连接分发端，请检查服务端 DELIVERY_BASE_URL 与分发端状态");
  }

  const contentType = (upstream.headers.get("content-type") ?? "").toLowerCase();

  // play 响应：manifest_url / subtitles[].url 改写为同源代理路径（SDK 拿到的即浏览器可用地址）
  if (PLAY_PATH.test(segments.join("/")) && contentType.includes("application/json")) {
    const body = (await upstream.json().catch(() => null)) as unknown;
    if (body === null) {
      return new Response(null, { status: upstream.status, headers: noStore(new Headers()) });
    }
    return NextResponse.json(rewritePlayResponse(body), {
      status: upstream.status,
      headers: { "Cache-Control": "no-store" },
    });
  }

  // HLS 清单：改写内部的子清单 / 密钥 / 分片 URL（清单与 key 响应必须 no-store，P0 纪律）
  if (contentType.includes("mpegurl") || target.pathname.endsWith(".m3u8")) {
    const text = await upstream.text();
    return new Response(rewritePlaylist(text), {
      status: upstream.status,
      headers: { "Content-Type": "application/vnd.apple.mpegurl", "Cache-Control": "no-store" },
    });
  }

  const out = new Headers();
  for (const name of FORWARD_RESPONSE_HEADERS) {
    const value = upstream.headers.get(name);
    if (value) out.set(name, value);
  }
  noStore(out);
  // 无响应体的状态（204 / 304 / HEAD）不能带 body，否则 undici 直接抛错
  if (upstream.status === 204 || upstream.status === 304 || method === "HEAD") {
    return new Response(null, { status: upstream.status, headers: out });
  }
  return new Response(upstream.body, { status: upstream.status, headers: out });
}

export const GET = proxy;
export const POST = proxy;
export const HEAD = proxy;
export const PUT = proxy;
export const PATCH = proxy;
export const DELETE = proxy;
