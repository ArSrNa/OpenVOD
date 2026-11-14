// 控制台预览的分发端地址解析（2026-11-14）：系统设置优先、env 兜底、空配置明确报错。
// 不碰 DB（resolveBaseUrl 是纯函数）；模块级 getDb 只实例化客户端、不连库。
import { describe, expect, test } from "bun:test";

import { DeliveryPreviewError, resolveBaseUrl } from "@/lib/delivery-preview";

describe("resolveBaseUrl", () => {
  test("系统设置的地址优先于 env，且去掉尾部斜杠", () => {
    expect(resolveBaseUrl("https://delivery.example.com/", "http://127.0.0.1:9001")).toBe(
      "https://delivery.example.com",
    );
  });

  test("设置留空时回退 env", () => {
    expect(resolveBaseUrl("", "http://127.0.0.1:9001")).toBe("http://127.0.0.1:9001");
    expect(resolveBaseUrl("   ", "  https://delivery.example.com  ")).toBe("https://delivery.example.com");
  });

  test("两处都没有配置 → 501，不再静默用 127.0.0.1", () => {
    for (const env of ["", "  "]) {
      let error: unknown;
      try {
        resolveBaseUrl("", env);
      } catch (e) {
        error = e;
      }
      expect(error).toBeInstanceOf(DeliveryPreviewError);
      expect((error as DeliveryPreviewError).code).toBe("not_implemented");
      expect((error as DeliveryPreviewError).status).toBe(501);
    }
  });

  test("不是 http(s) 完整地址 → 400", () => {
    for (const bad of ["delivery.example.com", "ftp://delivery.example.com", "//delivery.example.com"]) {
      let error: unknown;
      try {
        resolveBaseUrl(bad, "");
      } catch (e) {
        error = e;
      }
      expect(error).toBeInstanceOf(DeliveryPreviewError);
      expect((error as DeliveryPreviewError).status).toBe(400);
    }
  });

  test("设置里写的本机地址照常可用（本地调试形态）", () => {
    expect(resolveBaseUrl("http://127.0.0.1:9001/", "")).toBe("http://127.0.0.1:9001");
  });
});
