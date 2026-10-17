// 取源通路优选单测（2026-10-17，ADR-0019 修订）：探测择优、缓存、去重与兜底回退。
// 背景：CDN 通路实测 0.71 MB/s、存储直连 44–103 MB/s（同一对象同一时刻），
// Worker 串行消费任务，取源耗时直接决定任务墙钟时长。
import { describe, expect, test } from "bun:test";
import { createSourceResolver, type SourceFetcher } from "../src/source-fetch";

function fetcher(id: string, url: string): SourceFetcher {
  return { id, presign: async () => url };
}

describe("createSourceResolver", () => {
  test("单候选：不探测，直接返回该通路 URL", async () => {
    let probes = 0;
    const resolver = createSourceResolver([fetcher("direct", "https://cos.example/original/1.mp4")], {
      measure: async () => {
        probes += 1;
        return 1;
      },
    });
    const r = await resolver.resolve("original/1.mp4", 3600);
    expect(r.via).toBe("direct");
    expect(r.url).toBe("https://cos.example/original/1.mp4");
    expect(probes).toBe(0);
  });

  test("多候选：选吞吐最快的通路（与候选顺序无关）", async () => {
    const speed: Record<string, number> = {
      "https://cdn.example/x": 0.7 * 1024 * 1024,
      "https://cos.example/x": 100 * 1024 * 1024,
    };
    const r = await createSourceResolver(
      [fetcher("signed", "https://cdn.example/x"), fetcher("direct", "https://cos.example/x")],
      { measure: async (url) => speed[url] ?? null },
    ).resolve("x", 3600);
    expect(r.via).toBe("direct");
    expect(r.url).toBe("https://cos.example/x");
  });

  test("探测结果缓存：TTL 内换 key 不再探测，直接复用选择", async () => {
    let probes = 0;
    const resolver = createSourceResolver(
      [fetcher("direct", "https://cos.example/a"), fetcher("signed", "https://cdn.example/a")],
      {
        measure: async (url) => {
          probes += 1;
          return url.includes("cos") ? 100 : 1;
        },
        cacheTtlMs: 60_000,
      },
    );
    expect((await resolver.resolve("a", 3600)).via).toBe("direct");
    expect(probes).toBe(2); // 两个候选各探一次
    expect((await resolver.resolve("b", 3600)).via).toBe("direct");
    expect(probes).toBe(2); // 命中缓存
  });

  test("缓存过期后重新探测", async () => {
    let probes = 0;
    let t = 0;
    const resolver = createSourceResolver(
      [fetcher("direct", "https://cos.example/a"), fetcher("signed", "https://cdn.example/a")],
      {
        measure: async () => {
          probes += 1;
          return 1;
        },
        cacheTtlMs: 1000,
        now: () => t,
      },
    );
    await resolver.resolve("a", 3600);
    expect(probes).toBe(2);
    t = 1001;
    await resolver.resolve("b", 3600);
    expect(probes).toBe(4);
  });

  test("presign 抛错的候选被跳过（不参与探测）", async () => {
    const broken: SourceFetcher = {
      id: "internal",
      presign: async () => {
        throw new Error("unreachable");
      },
    };
    const r = await createSourceResolver([broken, fetcher("direct", "https://cos.example/a")], {
      measure: async () => 10,
    }).resolve("a", 3600);
    expect(r.via).toBe("direct");
  });

  test("同 origin+path 的候选去重：不重复探测，继承首次结果", async () => {
    const probed: string[] = [];
    const r = await createSourceResolver(
      [fetcher("direct", "https://cos.example/a"), fetcher("signed", "https://cos.example/a?sign=xyz")],
      {
        measure: async (url) => {
          probed.push(url);
          return 5;
        },
      },
    ).resolve("a", 3600);
    expect(probed).toHaveLength(1);
    expect(r.via).toBe("direct");
  });

  test("全部探测失败：回退到最后一个可生成 URL 的候选（保守路径）", async () => {
    const r = await createSourceResolver(
      [fetcher("direct", "https://cos.example/a"), fetcher("signed", "https://cdn.example/a")],
      { measure: async () => null },
    ).resolve("a", 3600);
    expect(r.via).toBe("signed");
    expect(r.url).toBe("https://cdn.example/a");
  });

  test("全部候选不可用（presign 全抛错）：抛出明确错误", async () => {
    const broken: SourceFetcher = {
      id: "x",
      presign: async () => {
        throw new Error("unreachable");
      },
    };
    await expect(createSourceResolver([broken, broken], { measure: async () => 1 }).resolve("a", 3600)).rejects.toThrow(
      "全部候选通路均不可用",
    );
  });
});
