import { describe, expect, it } from "bun:test";
import { DashboardStatsResponse } from "@openvod/contracts";
import type { StorageObject } from "@openvod/storage";
import { getStorageStats } from "../src/lib/storage-stats";

const object = (key: string, size = 100): StorageObject => ({ key, size });

function inventory(objects: StorageObject[]) {
  const prefixes: string[] = [];
  return {
    prefixes,
    listObjects: async (prefix: string) => {
      prefixes.push(prefix);
      return objects.filter((entry) => entry.key.startsWith(prefix));
    },
  };
}

describe("首页 S3 资产统计", () => {
  it("只累加五个业务分区的实际大小，包含分片、字幕、封面、水印图片和未入库文件", async () => {
    const storage = inventory([
      object("original/00000001.mp4", 5_000_000_000),
      object("original/unregistered.mp4", 500),
      object("proceed/00000001/master.m3u8", 200),
      object("proceed/00000001/720p/seg-00000.ts", 20_000),
      object("proceed/00000001/subtitles/zh.vtt", 300),
      object("cover/00000001/poster.jpg", 400),
      object("metadata/00000001/probe.json", 100),
      object("watermark/clogo0000000000000000.png", 401),
      object("other-business/asset.bin", 999_999),
    ]);
    const result = await getStorageStats(storage);
    expect(result.storage.used_bytes).toBe(5_000_021_901);
    expect(result.originals).toHaveLength(2);
    expect(storage.prefixes.sort()).toEqual(["cover/", "metadata/", "original/", "proceed/", "watermark/"]);
  });

  it("多模板和旧布局按组计数，分片与字幕不增加组数，覆盖媒资去重", async () => {
    const templateA = "cmu6tpla0001mqe4uoyceqt3";
    const templateB = "cmu6tplb0002mqe4uoyceqt3";
    const result = await getStorageStats(inventory([
      object(`proceed/00000001/${templateA}/master.m3u8`),
      object(`proceed/00000001/${templateA}/720p/index.m3u8`),
      object(`proceed/00000001/${templateA}/720p/seg-00000.ts`),
      object(`proceed/00000001/${templateA}/720p/seg-00001.ts`),
      object(`proceed/00000001/${templateB}/master.m3u8`),
      object(`proceed/00000002/${templateA}/master.m3u8`),
      object("proceed/00000002/master.m3u8"),
      object("proceed/00000002/1080p/index.m3u8"),
      object("proceed/00000001/subtitles/zh.vtt"),
      object("proceed/00000001/subtitles/en.vtt"),
      object("proceed/00000003/subtitles/zh.vtt"),
      object("proceed/00000003/subtitles/backup.srt"),
      object("proceed/not-a-media/master.m3u8"),
      object("proceed/00000004/", 0),
      object(`proceed/00000005/${templateA}/`, 0),
    ]));
    expect(result.products).toEqual({ total: 4, media_count: 2 });
    expect(result.subtitles).toEqual({ total: 3, media_count: 2 });
  });

  it("元数据按实际对象区分探测、自定义和其它文件，忽略目录占位及非法媒资路径", async () => {
    const result = await getStorageStats(inventory([
      object("metadata/00000001/probe.json"),
      object("metadata/00000002/probe.json"),
      object("metadata/00000001/custom.json"),
      object("metadata/00000002/extras/analysis.json"),
      object("metadata/00000001/", 0),
      object("metadata/", 0),
      object("metadata/not-a-media/probe.json"),
      object("metadata/readme.txt"),
    ]));
    expect(result.metadata).toEqual({ total: 4, probe: 2, custom: 1, other: 1 });
  });

  it("空桶返回真实零值，并符合总览响应契约", async () => {
    const { originals, ...assets } = await getStorageStats(inventory([]));
    expect(originals).toEqual([]);
    expect(assets).toEqual({
      storage: { used_bytes: 0 },
      subtitles: { total: 0, media_count: 0 },
      products: { total: 0, media_count: 0 },
      metadata: { total: 0, probe: 0, custom: 0, other: 0 },
    });
    expect(DashboardStatsResponse.safeParse({
      media: { total: 0, ready: 0, not_ingested: 0 },
      jobs: { active: 0, queued: 0, probing: 0, encoding: 0, packaging: 0 },
      users: { total: 0, active: 0, disabled: 0 },
      ...assets,
    }).success).toBe(true);
  });

  it("分区列举失败时抛错，不把部分统计或失败伪装成零用量", async () => {
    await expect(getStorageStats({
      listObjects: async (prefix) => {
        if (prefix === "proceed/") throw new Error("S3 unavailable");
        return [];
      },
    })).rejects.toThrow("S3 unavailable");
  });
});
