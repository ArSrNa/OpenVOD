/// <reference types="bun" />

// 同源代理的 URL 改写纯函数守卫（spec.md §11.9，2026-11-12）：
// 浏览器请求的分发端地址必须变成同源 `/api/delivery` 路径；公网对象存储分片保持直连（字节不过 player 进程）。
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { DELIVERY_PROXY_PREFIX, rewritePlaylist, rewritePlayResponse, toProxyPath } from "../src/lib/delivery-server";

const original = process.env.DELIVERY_BASE_URL;

beforeEach(() => {
  process.env.DELIVERY_BASE_URL = "http://127.0.0.1:9000";
});

afterEach(() => {
  if (original === undefined) delete process.env.DELIVERY_BASE_URL;
  else process.env.DELIVERY_BASE_URL = original;
});

describe("toProxyPath", () => {
  test("分发端回环地址 → 同源代理路径", () => {
    expect(toProxyPath("http://127.0.0.1:9000/v1/media/m1/manifest/master.m3u8?t=x&tpl=")).toBe(
      `${DELIVERY_PROXY_PREFIX}/v1/media/m1/manifest/master.m3u8?t=x&tpl=`,
    );
  });

  test("公网分发端播放链路（清单 / 密钥 / 字幕）也走代理，避免依赖 DELIVERY_CORS_ORIGINS", () => {
    expect(toProxyPath("https://vod.example.com/v1/media/m1/key?t=k")).toBe(
      `${DELIVERY_PROXY_PREFIX}/v1/media/m1/key?t=k`,
    );
    expect(toProxyPath("https://vod.example.com/v1/media/m1/subtitles/s1.vtt?t=v")).toBe(
      `${DELIVERY_PROXY_PREFIX}/v1/media/m1/subtitles/s1.vtt?t=v`,
    );
  });

  test("公网对象存储分片保持直连（返回 null）", () => {
    expect(
      toProxyPath("https://bucket.cos.ap-guangzhou.myqcloud.com/proceed/m1/720p/seg0.m4s?sign=1"),
    ).toBeNull();
  });

  test("浏览器不可达的私有地址（本地 RustFS）→ 代理", () => {
    expect(toProxyPath("http://127.0.0.1:9002/bucket/proceed/m1/720p/seg0.m4s?sign=1")).toBe(
      `${DELIVERY_PROXY_PREFIX}/bucket/proceed/m1/720p/seg0.m4s?sign=1`,
    );
    expect(toProxyPath("http://192.168.1.9:9002/bucket/seg0.m4s")).toBe(`${DELIVERY_PROXY_PREFIX}/bucket/seg0.m4s`);
  });

  test("非 http(s) / 非法 URL 不改写", () => {
    expect(toProxyPath("data:text/plain;base64,AAAA")).toBeNull();
    expect(toProxyPath("not a url")).toBeNull();
  });
});

describe("rewritePlaylist", () => {
  test("主清单：子清单 URI 行改写为同源路径", () => {
    const master = [
      "#EXTM3U",
      "#EXT-X-VERSION:3",
      "#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=1280x720",
      "http://127.0.0.1:9000/v1/media/m1/manifest/720p/index.m3u8?t=v1&tpl=t1",
    ].join("\n");
    const out = rewritePlaylist(master).split("\n");
    expect(out[0]).toBe("#EXTM3U");
    expect(out[1]).toBe("#EXT-X-VERSION:3");
    expect(out[3]).toBe(`${DELIVERY_PROXY_PREFIX}/v1/media/m1/manifest/720p/index.m3u8?t=v1&tpl=t1`);
  });

  test("子清单：EXT-X-KEY 的 URI 属性改写，公网分片保持直连", () => {
    const variant = [
      "#EXTM3U",
      '#EXT-X-KEY:METHOD=AES-128,URI="http://127.0.0.1:9000/v1/media/m1/key?t=k1",IV=0x01',
      "#EXTINF:4.0,",
      "https://bucket.cos.ap-guangzhou.myqcloud.com/proceed/m1/720p/seg0.m4s?sign=1",
    ].join("\n");
    const out = rewritePlaylist(variant).split("\n");
    expect(out[1]).toBe(
      `#EXT-X-KEY:METHOD=AES-128,URI="${DELIVERY_PROXY_PREFIX}/v1/media/m1/key?t=k1",IV=0x01`,
    );
    expect(out[3]).toBe("https://bucket.cos.ap-guangzhou.myqcloud.com/proceed/m1/720p/seg0.m4s?sign=1");
  });
});

describe("rewritePlayResponse", () => {
  test("manifest_url 与 subtitles[].url 改写，其余字段原样", () => {
    const out = rewritePlayResponse({
      sid: "s1",
      manifest_url: "http://127.0.0.1:9000/v1/media/m1/manifest/master.m3u8?t=m",
      expires_at: "2026-01-01T00:00:00.000Z",
      template_id: "t1",
      templates: [{ id: "t1", name: null, is_default: true }],
      subtitles: [{ id: "s1", lang: "zh", label: "中文", is_default: true, url: "http://127.0.0.1:9000/v1/media/m1/subtitles/s1.vtt?t=v" }],
    });
    expect(out.manifest_url).toBe(`${DELIVERY_PROXY_PREFIX}/v1/media/m1/manifest/master.m3u8?t=m`);
    expect(out.subtitles[0].url).toBe(`${DELIVERY_PROXY_PREFIX}/v1/media/m1/subtitles/s1.vtt?t=v`);
    expect(out.sid).toBe("s1");
    expect(out.templates).toEqual([{ id: "t1", name: null, is_default: true }]);
  });

  test("非对象响应原样返回", () => {
    expect(rewritePlayResponse(null)).toBeNull();
    expect(rewritePlayResponse([1, 2])).toEqual([1, 2]);
  });
});
