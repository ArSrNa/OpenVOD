// 上传后自动生成元数据的 best-effort 编排单测（spec.md §2.1，2026-09-30）
// 覆盖：成功透传 probeKey / durationMs；探测失败降级不抛出、错误截断至上限、告警出口可注入。
// 被测函数为依赖注入的纯编排（./probe-auto），不连 DB / 不起 ffprobe。
import { describe, expect, it } from "bun:test";
import { AUTO_METADATA_ERROR_MAX, runAutoMetadata } from "../src/lib/probe-auto";
import type { GenerateMetadataResult } from "../src/lib/probe";

const MEDIA_ID = "00000042";

function fakeResult(durationMs: number | null): GenerateMetadataResult {
  return {
    id: MEDIA_ID,
    probeKey: `metadata/${MEDIA_ID}/probe.json`,
    summary: { durationMs } as unknown as GenerateMetadataResult["summary"],
  };
}

describe("runAutoMetadata", () => {
  it("探测成功：透传 probeKey 与摘要时长", async () => {
    const out = await runAutoMetadata(MEDIA_ID, { generate: async () => fakeResult(12345) });
    expect(out).toEqual({
      generated: true,
      probeKey: `metadata/${MEDIA_ID}/probe.json`,
      durationMs: 12345,
      error: null,
    });
  });

  it("摘要时长为 null：durationMs 归一化为 null，仍算成功", async () => {
    const out = await runAutoMetadata(MEDIA_ID, { generate: async () => fakeResult(null) });
    expect(out.generated).toBe(true);
    expect(out.durationMs).toBeNull();
  });

  it("探测失败：降级为 generated=false 且不抛出（上传不受影响），告警出口收到原因", async () => {
    const logs: string[] = [];
    const out = await runAutoMetadata(MEDIA_ID, {
      generate: async () => {
        throw new Error("ffprobe 探测失败（非媒体文件或已损坏）：Invalid data found");
      },
      log: (m) => logs.push(m),
    });
    expect(out.generated).toBe(false);
    expect(out.probeKey).toBeNull();
    expect(out.durationMs).toBeNull();
    expect(out.error).toContain("非媒体文件或已损坏");
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain(MEDIA_ID);
  });

  it("超长错误（ffprobe stderr）：截断至 AUTO_METADATA_ERROR_MAX", async () => {
    const out = await runAutoMetadata(MEDIA_ID, {
      generate: async () => {
        throw new Error("x".repeat(AUTO_METADATA_ERROR_MAX * 3));
      },
      log: () => {},
    });
    expect(out.error).toHaveLength(AUTO_METADATA_ERROR_MAX);
  });

  it("非 Error 抛出物（字符串）：仍被降级捕获", async () => {
    const out = await runAutoMetadata(MEDIA_ID, {
      generate: async () => {
        throw "boom";
      },
      log: () => {},
    });
    expect(out.generated).toBe(false);
    expect(out.error).toBe("boom");
  });
});
