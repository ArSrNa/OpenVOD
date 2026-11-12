// 任务日志环形缓冲单测（ADR-0017 修订）：有变化才写、环形裁剪、单行上限、失败重试、stop 收尾。
import { describe, expect, test } from "bun:test";
import { createJobLogSink } from "../src/job-log";

function harness(opts: { maxBytes?: number; failTimes?: number } = {}) {
  const writes: string[] = [];
  let seq = 0;
  let failing = opts.failTimes ?? 0;
  const sink = createJobLogSink({
    write: async (tail) => {
      if (failing > 0) {
        failing--;
        throw new Error("db down");
      }
      writes.push(tail);
      return ++seq;
    },
    maxBytes: opts.maxBytes,
    // 不参与调度的假调度器：单测只用 flush()/stop() 显式推进
    schedule: () => () => {},
    onError: () => {},
  });
  return { sink, writes };
}

describe("createJobLogSink", () => {
  test("有变化才写库；无变化 flush 返回 false", async () => {
    const { sink, writes } = harness();
    sink.line("a");
    expect(await sink.flush()).toBe(true);
    expect(writes).toEqual(["a"]);
    expect(await sink.flush()).toBe(false);
    expect(writes).toEqual(["a"]);
    sink.line("b");
    expect(await sink.flush()).toBe(true);
    expect(writes.at(-1)).toBe("a\nb");
    expect(sink.seq()).toBe(2);
  });

  test("空行忽略", async () => {
    const { sink, writes } = harness();
    sink.line("");
    sink.line("\r");
    expect(await sink.flush()).toBe(false);
    expect(writes).toEqual([]);
  });

  test("超过字节上限时从最旧的行开始丢弃（保留尾部）", async () => {
    const { sink, writes } = harness({ maxBytes: 20 });
    for (let i = 1; i <= 5; i++) sink.line(`line${i}`); // 每行 6 字节（含换行）
    await sink.flush();
    const tail = writes.at(-1)!;
    expect(tail).toBe("line3\nline4\nline5"); // 3 行 18 字节；再加 line2 会超 20
    expect(Buffer.byteLength(tail, "utf8")).toBeLessThanOrEqual(20);
  });

  test("单行超长先截断，避免一行吃满环形", async () => {
    const { sink, writes } = harness();
    sink.line("x".repeat(10_000));
    await sink.flush();
    expect(Buffer.byteLength(writes.at(-1)!, "utf8")).toBeLessThanOrEqual(2 * 1024);
  });

  test("写库失败不抛，下一轮重试（dirty 保持）", async () => {
    const { sink, writes } = harness({ failTimes: 1 });
    sink.line("a");
    expect(await sink.flush()).toBe(false);
    expect(writes).toEqual([]);
    expect(await sink.flush()).toBe(true);
    expect(writes).toEqual(["a"]);
  });

  test("stop 落最后一批", async () => {
    const { sink, writes } = harness();
    sink.line("final");
    await sink.stop();
    expect(writes).toEqual(["final"]);
    // stop 之后不再接受新行
    sink.line("late");
    await sink.stop();
    expect(writes).toEqual(["final"]);
  });
});
