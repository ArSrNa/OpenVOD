// runFFmpeg 取消（spec.md §5.1，2026-11-12）：管理端取消任务时，worker 通过 AbortSignal 杀掉 ffmpeg。
// 断言两条路径：① 执行中 abort → 进程被终止并以 FFmpegError 拒绝（不等到 6 小时兜底超时）；
//              ② 已 abort 的 signal → 根本不启动 ffmpeg。缺 ffmpeg 时跳过。
import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runFFmpeg } from "../src/index";

const hasFFmpeg = Boolean(Bun.which("ffmpeg"));

describe("runFFmpeg 取消", () => {
  it.skipIf(!hasFFmpeg)(
    "执行中 abort：终止 ffmpeg 并按 FFmpegError 拒绝",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "openvod-ffmpeg-abort-"));
      const controller = new AbortController();
      // 60s / 720p 的编码远长于 abort 延迟，保证中断命中执行中而非结束后
      const promise = runFFmpeg(
        [
          "-y", "-loglevel", "error",
          "-f", "lavfi", "-i", "testsrc=size=1280x720:rate=30",
          "-c:v", "libx264", "-preset", "ultrafast",
          "-t", "60", join(dir, "out.mp4"),
        ],
        { signal: controller.signal },
      );
      setTimeout(() => controller.abort(), 300);
      await expect(promise).rejects.toThrow(/已取消/);
      rmSync(dir, { recursive: true, force: true });
    },
    30_000,
  );

  it.skipIf(!hasFFmpeg)(
    "已 abort 的 signal：不启动进程，直接拒绝",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "openvod-ffmpeg-preabort-"));
      const controller = new AbortController();
      controller.abort();
      await expect(
        runFFmpeg(["-y", "-f", "lavfi", "-i", "testsrc=size=64x64:rate=10", "-t", "1", join(dir, "out.mp4")], {
          signal: controller.signal,
        }),
      ).rejects.toThrow(/已取消/);
      expect(existsSync(join(dir, "out.mp4"))).toBe(false);
      rmSync(dir, { recursive: true, force: true });
    },
    30_000,
  );
});
