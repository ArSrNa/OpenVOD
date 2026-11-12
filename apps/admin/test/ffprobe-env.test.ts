// ffprobe 可用性自检单测（2026-11-13）：验证三类失败被区分开——
// 未安装（ENOENT）／系统库被遮蔽（GLIBCXX 报错走 stderr 摘要）／无响应（超时信号）。
// 被测函数依赖注入执行器，不真起 ffprobe。
import { describe, expect, it } from "bun:test";
import { describeFFprobeFailure, probeFFprobeAvailability } from "../src/lib/ffprobe-env";

describe("probeFFprobeAvailability", () => {
  it("可用：返回 null", async () => {
    expect(await probeFFprobeAvailability(async () => ({ stdout: "ffprobe version 6.1.1" }))).toBeNull();
  });

  it("未安装：ENOENT 明确指出 PATH 上没有 ffmpeg", async () => {
    const reason = await probeFFprobeAvailability(async () => {
      throw Object.assign(new Error("spawn ffprobe ENOENT"), { code: "ENOENT" });
    });
    expect(reason).toContain("未找到 ffprobe 可执行文件");
  });

  it("动态库遮蔽：把 stderr 尾部带出来，而不是笼统说“缺少 ffprobe”", async () => {
    const stderr =
      "/usr/bin/ffprobe: /lib/x86_64-linux-gnu/libstdc++.so.6: version `GLIBCXX_3.4.32' not found " +
      "(required by /usr/bin/ffprobe)";
    const reason = await probeFFprobeAvailability(async () => {
      throw Object.assign(new Error("Command failed: ffprobe -version"), { code: 1, stderr });
    });
    expect(reason).toContain("GLIBCXX_3.4.32");
  });

  it("超时 / 被信号终止：报告无响应", async () => {
    const reason = await probeFFprobeAvailability(async () => {
      throw Object.assign(new Error("Command failed: ffprobe -version"), { killed: true, signal: "SIGTERM" });
    });
    expect(reason).toContain("无响应");
  });
});

describe("describeFFprobeFailure", () => {
  it("超长 stderr 压成单行并截断至 200 字符（保留尾部，错误原因通常在末尾）", () => {
    const stderr = `${"x".repeat(500)}\nnot found`;
    const reason = describeFFprobeFailure({ code: 1, stderr });
    expect(reason).not.toContain("\n");
    expect(reason.endsWith("not found")).toBe(true);
    expect(reason.length).toBeLessThanOrEqual("ffprobe 执行失败：".length + 200);
  });

  it("既无 stderr 也无 message：回落到 code", () => {
    expect(describeFFprobeFailure({ code: 137 })).toContain("code=137");
  });
});
