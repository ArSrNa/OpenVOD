/**
 * 播放端 → 分发端的**服务端**接线（spec.md §11.9，2026-11-12）。
 *
 * 纪律：浏览器只与本应用**同源**通信——业务 API（login / media / play）、清单、密钥、字幕全部经
 * `/api/delivery/**` 代理到 `DELIVERY_BASE_URL`。因此：
 *   - 分发端地址（容器内 `127.0.0.1`、Docker 服务名、内网域名）永不出现在浏览器；
 *   - 不再需要 `PLAYER_PUBLIC_DELIVERY_BASE_URL` / `NEXT_PUBLIC_DELIVERY_BASE_URL`，
 *     也不再需要为业务 API / 清单 / 密钥配置 `DELIVERY_CORS_ORIGINS`。
 *
 * 例外：**分片字节仍走对象存储**（预签名直出），公网地址保持直连不经过本代理（性能与「字节不过函数」的
 * 一贯取向）；只有浏览器不可达的地址（本机回环 / 私有网段，典型是本地 RustFS）才由代理转发（仅开发 /
 * 体验环境形态）。
 */

import { envValue, stripQuotes } from "./env";

const DEFAULT_DELIVERY_BASE_URL = "http://127.0.0.1:9000";

/** 浏览器同源代理前缀（SDK baseUrl 与清单内改写后的 URL 都指向它） */
export const DELIVERY_PROXY_PREFIX = "/api/delivery";

/** 服务端视角的分发端地址（容器内 127.0.0.1 = 容器自身，部署时按需覆盖） */
export function deliveryBaseUrl(): string {
  return (envValue(process.env.DELIVERY_BASE_URL) || DEFAULT_DELIVERY_BASE_URL).replace(/\/+$/, "");
}

/** 预览账号：优先 PLAYER_PREVIEW_*，缺省回退管理端预览账号 DELIVERY_PREVIEW_*（spec.md §11.2） */
export function previewCredentials(): { username: string; password: string } | null {
  const username = envValue(process.env.PLAYER_PREVIEW_USERNAME) || envValue(process.env.DELIVERY_PREVIEW_USERNAME);
  const password =
    stripQuotes(process.env.PLAYER_PREVIEW_PASSWORD ?? "") ||
    stripQuotes(process.env.DELIVERY_PREVIEW_PASSWORD ?? "");
  if (!username || !password) return null;
  return { username, password };
}

/** 浏览器几乎不可能访问的地址形态（本机回环 / 私有网段）：这类资源必须经代理转发 */
function isBrowserUnreachable(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host === "::1" || host === "::" || host === "0.0.0.0") return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!v4) return false;
  const [a, b] = [Number(v4[1]), Number(v4[2])];
  return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

/** 分发端播放链路路径（清单 / 密钥 / 字幕）：无论域名是否公网都经代理，避免依赖 `DELIVERY_CORS_ORIGINS` */
function isDeliveryPlaybackPath(pathname: string): boolean {
  return /^\/v1\/media\/[^/]+\/(manifest\/|key$|subtitles\/)/.test(pathname);
}

/**
 * 绝对 URL → 同源代理路径；应保持直连的（公网对象存储 / CDN 分片）返回 null。
 * 代理路径是**相对**形态（`/api/delivery/...`）：浏览器按页面 / 清单所在源站解析，无需知道对外域名。
 */
export function toProxyPath(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  const deliveryHost = new URL(deliveryBaseUrl()).host;
  if (url.host !== deliveryHost && !isBrowserUnreachable(url.hostname) && !isDeliveryPlaybackPath(url.pathname)) {
    return null;
  }
  return `${DELIVERY_PROXY_PREFIX}${url.pathname}${url.search}`;
}

/**
 * HLS 清单改写（主清单 → 子清单 → 分片 / 密钥）：
 *   - URI 行（子清单 / 分片 / `EXT-X-MAP`）按 `toProxyPath` 决定代理或直连；
 *   - 标签属性 `URI="..."`（`EXT-X-KEY` 的密钥地址、`EXT-X-MEDIA` 等）同样处理；
 *   - 其余标签原样保留（`#EXT-X-VERSION` 等）。
 */
export function rewritePlaylist(text: string): string {
  const rewrite = (uri: string) => toProxyPath(uri) ?? uri;
  return text
    .split(/\r?\n/)
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed) return line;
      if (trimmed.startsWith("#")) {
        return line.replace(/URI="([^"]*)"/g, (_match, uri: string) => `URI="${rewrite(uri)}"`);
      }
      return rewrite(trimmed);
    })
    .join("\n");
}

/** `POST /v1/media/{id}/play` 响应改写：`manifest_url` 与 `subtitles[].url` 转同源代理路径 */
export function rewritePlayResponse<T>(body: T): T {
  if (!body || typeof body !== "object" || Array.isArray(body)) return body;
  const raw = body as Record<string, unknown>;
  const out: Record<string, unknown> = { ...raw };
  if (typeof raw.manifest_url === "string") {
    out.manifest_url = toProxyPath(raw.manifest_url) ?? raw.manifest_url;
  }
  if (Array.isArray(raw.subtitles)) {
    out.subtitles = raw.subtitles.map((item) => {
      if (!item || typeof item !== "object") return item;
      const track = item as Record<string, unknown>;
      if (typeof track.url !== "string") return item;
      return { ...track, url: toProxyPath(track.url) ?? track.url };
    });
  }
  return out as T;
}
