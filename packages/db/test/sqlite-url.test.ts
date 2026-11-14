// SQLite 连接串归一（ADR-0020）：相对路径基准必须与 Prisma CLI / Go 分发端一致
import { expect, test } from "bun:test";
import { sqliteFileUrl } from "../src/index";

test("相对路径以 packages/db/prisma 为基准", () => {
  const url = sqliteFileUrl("file:./dev.db");
  expect(url.startsWith("file:/")).toBe(true);
  expect(url.endsWith("/packages/db/prisma/dev.db")).toBe(true);
});

test("绝对路径与 sqlite:// 统一成 file:", () => {
  expect(sqliteFileUrl("file:///tmp/a.db")).toBe("file:/tmp/a.db");
  expect(sqliteFileUrl("file:/tmp/a.db")).toBe("file:/tmp/a.db");
  expect(sqliteFileUrl("sqlite:///tmp/b.db")).toBe("file:/tmp/b.db");
});

test("连接池参数被丢弃（只保留路径）", () => {
  expect(sqliteFileUrl("file:/tmp/c.db?connection_limit=1")).toBe("file:/tmp/c.db");
});

test("非 SQLite 连接串直接报错", () => {
  expect(() => sqliteFileUrl("mysql://user:pw@host:3306/openvod")).toThrow();
});
