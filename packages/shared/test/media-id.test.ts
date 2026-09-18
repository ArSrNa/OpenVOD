// 媒资数字 ID 生成器（spec.md §1.3）
import { describe, expect, test } from "bun:test";
import {
  MEDIA_ID_CONFIG,
  generateMediaId,
  resolveMediaIdLength,
} from "../src/index";

describe("resolveMediaIdLength", () => {
  test("缺省回退默认 8", () => {
    expect(resolveMediaIdLength(undefined)).toBe(8);
    expect(resolveMediaIdLength("")).toBe(8);
    expect(resolveMediaIdLength(null)).toBe(8);
  });

  test("非法值回退默认 8", () => {
    expect(resolveMediaIdLength("abc")).toBe(8);
    expect(resolveMediaIdLength("3.5")).toBe(8);
    expect(resolveMediaIdLength("3")).toBe(8); // < min
    expect(resolveMediaIdLength("17")).toBe(8); // > max
  });

  test("边界值合法", () => {
    expect(resolveMediaIdLength("4")).toBe(4);
    expect(resolveMediaIdLength("16")).toBe(16);
  });
});

describe("generateMediaId", () => {
  test("位数正确且为纯数字字符串", () => {
    for (const n of [4, 8, 16]) {
      const id = generateMediaId(n);
      expect(id).toHaveLength(n);
      expect(id).toMatch(/^\d+$/);
    }
  });

  test("保留前导零（spec.md §1.3 示例 00000042 形态）", () => {
    // 统计学断言：8 位 ID 采样 200 个，前导零概率 ≈ 10% + 1/10^8，必然出现
    const ids = Array.from({ length: 200 }, () => generateMediaId(2));
    expect(ids.some((id) => id.startsWith("0"))).toBe(true);
  });

  test("默认长度 = MEDIA_ID_CONFIG.defaultLength", () => {
    expect(generateMediaId()).toHaveLength(MEDIA_ID_CONFIG.defaultLength);
  });

  test("非法位数抛错", () => {
    expect(() => generateMediaId(0)).toThrow();
    expect(() => generateMediaId(33)).toThrow();
    expect(() => generateMediaId(1.5)).toThrow();
  });

  test("值域在 [0, 10^n) 内", () => {
    for (let i = 0; i < 50; i++) {
      const id = generateMediaId(8);
      expect(Number(id)).toBeLessThan(10 ** 8);
      expect(Number(id)).toBeGreaterThanOrEqual(0);
    }
  });
});
