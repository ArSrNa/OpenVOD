// lastError 截断回归（2026-10-17）：`transcode_jobs.last_error` 为 VARCHAR(191)，
// 而 ffmpeg 失败消息是数百字符的 stderr 片段 → P2000 → 失败状态写不进库 → 任务永远
// 停在「转码中」并被反复重认领（9 个任务停摆事件的放大器）。
import { describe, expect, test } from "bun:test";
import { clampLastError, LAST_ERROR_MAX_CODEPOINTS } from "../src/job-store";

describe("clampLastError（VARCHAR(191) 回归守卫）", () => {
  test("短消息原样保留", () => {
    const msg = "ffmpeg 失败（exit 非零）：Cannot open libx265 encoder.";
    expect(clampLastError(msg)).toBe(msg);
  });

  test("恰好等于上限：不截断", () => {
    const msg = "x".repeat(LAST_ERROR_MAX_CODEPOINTS);
    expect(clampLastError(msg)).toBe(msg);
  });

  test("超长：收敛到上限，保头（80）保尾（110）", () => {
    const head = "头".repeat(80);
    const tail = "尾".repeat(40);
    const out = clampLastError(`${head}${"中".repeat(500)}${tail}`);
    expect([...out].length).toBe(LAST_ERROR_MAX_CODEPOINTS);
    expect(out.startsWith(head)).toBe(true);
    expect(out.endsWith(tail)).toBe(true);
  });

  test("按代码点切：多字节字符 / emoji 不被劈裂成替换符", () => {
    const out = clampLastError("😀".repeat(300));
    expect([...out].length).toBe(LAST_ERROR_MAX_CODEPOINTS);
    expect(out).not.toContain("\uFFFD");
  });
});
