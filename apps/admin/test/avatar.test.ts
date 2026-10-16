// 左下角头像的 URL 生成口径（Cravatar / Gravatar 兼容）：
// 邮箱去空格 + 转小写后取 MD5，拼 https://cravatar.cn/avatar/{hash}?s={size}&d=404。
// 纯函数测试，不连库、不依赖 Next。
import { expect, test } from "bun:test";
import { cravatarAvatarUrl } from "../src/lib/avatar";

test("邮箱转为 Cravatar 头像 URL（md5 十六进制 + s 尺寸 + d=404 回退）", () => {
  // md5("test@example.com") 的标准值，跨实现可校验
  expect(cravatarAvatarUrl("test@example.com")).toBe(
    "https://cravatar.cn/avatar/55502f40dc8b7c769880b10874abc9d0?s=400&d=404",
  );
});

test("大小写与首尾空格不影响哈希（同 Gravatar 规范）", () => {
  expect(cravatarAvatarUrl("  Admin@Example.COM ")).toBe(cravatarAvatarUrl("admin@example.com"));
});

test("可指定头像尺寸", () => {
  expect(cravatarAvatarUrl("a@b.c", 80)).toContain("?s=80");
});

test("邮箱缺失时返回 undefined（客户端回退占位图标）", () => {
  expect(cravatarAvatarUrl(undefined)).toBeUndefined();
  expect(cravatarAvatarUrl(null)).toBeUndefined();
  expect(cravatarAvatarUrl("   ")).toBeUndefined();
});
