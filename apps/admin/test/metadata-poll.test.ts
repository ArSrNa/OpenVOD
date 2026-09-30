// 上传后元数据「前端延迟更新」轮询编排单测（spec.md §2.1，2026-09-30）
// 覆盖：首轮就绪 / 中途就绪 / 序列耗尽 → false / 单次查询失败不终止轮询 / 自定义间隔序列。
// 被测函数为依赖注入的纯编排（./metadata-poll），不连 DB / 不发请求。
import { describe, expect, it } from "bun:test";
import { METADATA_POLL_DELAYS_MS, pollMetadataReady } from "../src/lib/metadata-poll";

const MEDIA_ID = "00000042";

/** 立即返回的 sleep + 记录调用到的间隔（不真实等待） */
function makeSleep(record: number[] = []): (ms: number) => Promise<void> {
  return async (ms) => {
    record.push(ms);
  };
}

describe("pollMetadataReady", () => {
  it("首轮就绪：返回 true，仅查询一次，只等了第一个间隔", async () => {
    let calls = 0;
    const slept: number[] = [];
    const ready = await pollMetadataReady(MEDIA_ID, {
      sleep: makeSleep(slept),
      fetchDetail: async () => {
        calls += 1;
        return { probe: { container: "mp4" } };
      },
    });
    expect(ready).toBe(true);
    expect(calls).toBe(1);
    expect(slept).toEqual([METADATA_POLL_DELAYS_MS[0]]);
  });

  it("第三轮才就绪：空 probe 继续轮询，按递增间隔等待", async () => {
    let calls = 0;
    const slept: number[] = [];
    const ready = await pollMetadataReady(MEDIA_ID, {
      sleep: makeSleep(slept),
      fetchDetail: async () => {
        calls += 1;
        return calls < 3 ? { probe: null } : { probe: { container: "mp4" } };
      },
    });
    expect(ready).toBe(true);
    expect(calls).toBe(3);
    expect(slept).toEqual(METADATA_POLL_DELAYS_MS.slice(0, 3) as unknown as number[]);
  });

  it("序列耗尽仍未就绪 → false，查询次数等于间隔数", async () => {
    let calls = 0;
    const ready = await pollMetadataReady(MEDIA_ID, {
      sleep: makeSleep(),
      fetchDetail: async () => {
        calls += 1;
        return { probe: null };
      },
    });
    expect(ready).toBe(false);
    expect(calls).toBe(METADATA_POLL_DELAYS_MS.length);
  });

  it("单次查询抛错不终止轮询（服务端探测仍在进行）", async () => {
    let calls = 0;
    const ready = await pollMetadataReady(MEDIA_ID, {
      sleep: makeSleep(),
      fetchDetail: async () => {
        calls += 1;
        if (calls === 1) throw new Error("网络抖动");
        return { probe: { container: "mp4" } };
      },
    });
    expect(ready).toBe(true);
    expect(calls).toBe(2);
  });

  it("自定义间隔序列生效（测试 / 特殊场景可调）", async () => {
    const slept: number[] = [];
    const ready = await pollMetadataReady(MEDIA_ID, {
      sleep: makeSleep(slept),
      fetchDetail: async () => ({ probe: null }),
      delays: [10, 20],
    });
    expect(ready).toBe(false);
    expect(slept).toEqual([10, 20]);
  });
});
