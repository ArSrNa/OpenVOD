// local 适配器：流式上传往返（M1 管理端原视频直传路径，ADR-0005）
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, readFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalAdapter } from "../src/local";

let root: string;
let adapter: LocalAdapter;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "openvod-storage-"));
  adapter = new LocalAdapter({ root });
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

function streamOf(chunks: string[]): ReadableStream {
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(new TextEncoder().encode(c));
      controller.close();
    },
  });
}

describe("LocalAdapter.putStream", () => {
  test("流式写入内容完整（多 chunk 拼接）", async () => {
    const key = "original/00000042.mp4";
    await adapter.putStream(key, streamOf(["hello ", "vod ", "world"]));
    const buf = await readFile(join(root, key));
    expect(new TextDecoder().decode(buf)).toBe("hello vod world");
    expect(await adapter.stat(key)).toEqual({ size: 15 });
  });

  test("自动创建多级目录（root 前缀 + 分区）", async () => {
    const a = new LocalAdapter({ root, rootPrefix: "prod/vod" });
    const key = "cover/00000001/poster.png";
    await a.putStream(key, streamOf(["png"]));
    const buf = await readFile(join(root, "prod/vod", key));
    expect(buf.byteLength).toBe(3);
  });

  test("listObjects 返回相对键且含 lastModified/size", async () => {
    await adapter.putStream("proceed/00000042/v0/index.m3u8", streamOf(["#EXTM3U"]));
    const objs = await adapter.listObjects("proceed/");
    expect(objs.map((o) => o.key)).toContain("proceed/00000042/v0/index.m3u8");
    expect(objs[0].size).toBeGreaterThan(0);
    expect(objs[0].lastModified).toBeInstanceOf(Date);
  });

  test("delete 后 stat 为 null（幂等不抛错）", async () => {
    const key = "metadata/00000042/probe.json";
    await adapter.putStream(key, streamOf(["{}"]));
    await adapter.delete(key);
    expect(await adapter.stat(key)).toBeNull();
    await expect(adapter.delete(key)).resolves.toBeUndefined();
  });

  test("get 读取内容一致", async () => {
    await adapter.put("original/00000043.mkv", new TextEncoder().encode("abc"));
    const data = await adapter.get("original/00000043.mkv");
    expect(new TextDecoder().decode(data)).toBe("abc");
  });

  test("putStream 目标目录为文件路径时抛错（路径穿越防护）", async () => {
    await adapter.put("plain.txt", "x");
    await expect(adapter.putStream("plain.txt/child", streamOf(["y"]))).rejects.toThrow();
  });
});
