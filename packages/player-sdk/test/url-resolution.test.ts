// 请求 URL 组装（player-sdk-spec.md §1）：宿主同源代理下 play 响应可能下发**根相对**地址
// （`/api/delivery/v1/...`，见 spec.md §11.9 的 apps/player），此时必须按 baseUrl 的源站解析，
// 不能与 baseUrl 的路径段重复拼接。
import { describe, expect, it } from "bun:test";

import { createPlayerSdk } from "../src";
import { createFetchStub, textResponse } from "./helpers";

const PROXY_BASE = "https://player.test/api/delivery";
const RELATIVE_VTT = "/api/delivery/v1/media/m1/subtitles/t1.vtt?t=tok";

describe("根相对资源地址解析", () => {
  it("attach 模式的字幕 URL 以 baseUrl 源站补全（不重复 /api/delivery 段）", async () => {
    const stub = createFetchStub(() => textResponse(200, "WEBVTT\n"));
    const sdk = createPlayerSdk({ baseUrl: PROXY_BASE, fetch: stub.fetch });

    const handle = sdk.attachPlayback({
      media_id: "m1",
      manifest_url: "/api/delivery/v1/media/m1/manifest/master.m3u8?t=m",
      subtitles: [{ id: "t1", lang: "zh", label: "中文", is_default: true, url: RELATIVE_VTT }],
    });

    const text = await handle.fetchSubtitleText(handle.subtitles[0]);
    expect(text).toContain("WEBVTT");
    expect(stub.calls).toHaveLength(1);
    expect(stub.calls[0].url).toBe(`https://player.test${RELATIVE_VTT}`);
  });

  it("绝对 URL 原样使用", async () => {
    const stub = createFetchStub(() => textResponse(200, "WEBVTT\n"));
    const sdk = createPlayerSdk({ baseUrl: PROXY_BASE, fetch: stub.fetch });
    const absolute = "https://cdn.example.com/proceed/m1/subtitles/t1.vtt?t=tok";

    const handle = sdk.attachPlayback({
      media_id: "m1",
      manifest_url: "/api/delivery/v1/media/m1/manifest/master.m3u8?t=m",
      subtitles: [{ id: "t1", lang: "zh", label: "中文", is_default: true, url: absolute }],
    });

    await handle.fetchSubtitleText(handle.subtitles[0]);
    expect(stub.calls[0].url).toBe(absolute);
  });
});
