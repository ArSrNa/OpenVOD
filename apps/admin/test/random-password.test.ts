// 随机口令生成工具单测（../src/lib/random-password）：
// 口令用于「新建用户 / 重置密码」表单，长度与字符集须兼容 contracts UserPassword（8–72 位）。
import { describe, expect, it } from "bun:test";
import { generatePassword } from "../src/lib/random-password";

describe("generatePassword", () => {
  it("默认 12 位，仅含字母与数字，且不含易混淆字符（0/O、1/I/l）", () => {
    const pwd = generatePassword();
    expect(pwd).toHaveLength(12);
    expect(pwd).toMatch(/^[a-zA-Z0-9]+$/);
    expect(pwd).not.toMatch(/[0O1Il]/);
  });

  it("至少各含 1 位小写 / 大写 / 数字", () => {
    for (let i = 0; i < 50; i += 1) {
      const pwd = generatePassword();
      expect(pwd).toMatch(/[a-z]/);
      expect(pwd).toMatch(/[A-Z]/);
      expect(pwd).toMatch(/[2-9]/);
      expect(pwd).toHaveLength(12);
    }
  });

  it("可按需指定长度，且不少于 3 位", () => {
    expect(generatePassword(20)).toHaveLength(20);
    expect(generatePassword(2)).toHaveLength(3);
  });

  it("连续两次生成不相同", () => {
    expect(generatePassword()).not.toBe(generatePassword());
  });
});
