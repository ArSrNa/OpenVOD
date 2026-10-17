// 源片拉取单测（2026-10-17，spec.md §5.1「拉取源片」阶段）：
// 流式落盘 + 进度、完整性校验、读停滞中止、本地路径复用。
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fetchSourceToLocal } from "../src/source-download";

const tempDir = () => mkdtempSync(join(tmpdir(), "openvod-dl-"));

describe("fetchSourceToLocal", () => {
  test("本地路径直接复用（不复制、不读盘）", async () => {
    const dir = tempDir();
    const src = join(dir, "src.mp4");
    writeFileSync(src, "local-source");
    const r = await fetchSourceToLocal({ url: src, destPath: join(dir, "dest.mp4") });
    expect(r).toEqual({ input: src, bytes: 0, downloaded: false });
    rmSync(dir, { recursive: true, force: true });
  });

  test("HTTP 流式落盘：字节数与源一致，进度推进到 100%", async () => {
    const payload = new Uint8Array(3 * 1024 * 1024).fill(7);
    const server = Bun.serve({ port: 0, fetch: () => new Response(payload) });
    const dir = tempDir();
    const dest = join(dir, "out.mp4");
    const ratios: number[] = [];
    const r = await fetchSourceToLocal({
      url: `http://127.0.0.1:${server.port}/src`,
      destPath: dest,
      totalBytes: payload.byteLength,
      onProgress: (downloaded, total) => ratios.push(downloaded / total!),
    });
    await server.stop(true);
    expect(r.downloaded).toBe(true);
    expect(r.bytes).toBe(payload.byteLength);
    expect(r.input).toBe(dest);
    expect(readFileSync(dest).byteLength).toBe(payload.byteLength);
    expect(ratios.length).toBeGreaterThan(0);
    expect(ratios.at(-1)).toBe(1);
    rmSync(dir, { recursive: true, force: true });
  });

  test("HTTP 非 2xx：报错带状态码", async () => {
    const server = Bun.serve({ port: 0, fetch: () => new Response("denied", { status: 403 }) });
    await expect(
      fetchSourceToLocal({ url: `http://127.0.0.1:${server.port}/x`, destPath: join(tempDir(), "o") }),
    ).rejects.toThrow(/HTTP 403/);
    await server.stop(true);
  });

  test("字节数不符（响应被截断）：报「不完整」而不是交给编码器", async () => {
    const server = Bun.serve({ port: 0, fetch: () => new Response(new Uint8Array(1024)) });
    const dir = tempDir();
    await expect(
      fetchSourceToLocal({
        url: `http://127.0.0.1:${server.port}/x`,
        destPath: join(dir, "o"),
        totalBytes: 10 * 1024 * 1024,
      }),
    ).rejects.toThrow(/不完整/);
    await server.stop(true);
    rmSync(dir, { recursive: true, force: true });
  });

  test("读停滞超过 idleTimeoutMs：中止并给出可读原因", async () => {
    // 永不产出数据的响应体：模拟 CDN 挂起（对齐 ffmpeg 输入 -rw_timeout 的口径）
    const server = Bun.serve({
      port: 0,
      fetch: () => new Response(new ReadableStream({ start() {} })),
    });
    const dir = tempDir();
    const t0 = Date.now();
    await expect(
      fetchSourceToLocal({ url: `http://127.0.0.1:${server.port}/x`, destPath: join(dir, "o"), idleTimeoutMs: 200 }),
    ).rejects.toThrow(/停滞/);
    expect(Date.now() - t0).toBeLessThan(5000);
    await server.stop(true);
    rmSync(dir, { recursive: true, force: true });
  });
});
