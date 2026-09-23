// 媒资分类与自定义元数据纯函数（spec.md §8 / ADR-0016）
// 覆盖：分类路径拼接、标签归一化、稀疏投影构建（空项不出现在投影里）。
import { describe, expect, test } from "bun:test";
import {
  buildMediaCustomData,
  mediaCategoryPath,
  normalizeMediaTags,
  MEDIA_CATEGORY_ID_PATTERN,
  MEDIA_CATEGORY_PATH_SEPARATOR,
  MEDIA_DEFAULT_CATEGORY_ID,
  MEDIA_DEFAULT_CATEGORY_NAME,
} from "../src/index";

// 默认分类「其他」（spec.md §8.1 修订）：固定 ID 必须符合分类 ID 形状白名单
// （路由 / 参数校验用 MEDIA_CATEGORY_ID_PATTERN；迁移与运行时幂等创建共用该常量）
describe("默认分类「其他」常量", () => {
  test("ID 形状符合 MEDIA_CATEGORY_ID_PATTERN", () => {
    expect(MEDIA_CATEGORY_ID_PATTERN.test(MEDIA_DEFAULT_CATEGORY_ID)).toBe(true);
  });

  test("默认名为「其他」", () => {
    expect(MEDIA_DEFAULT_CATEGORY_NAME).toBe("其他");
  });
});

describe("mediaCategoryPath", () => {
  test("祖先名 → 自身名用 ` / ` 连接", () => {
    expect(mediaCategoryPath(["电影", "科幻", "硬科幻"])).toBe("电影 / 科幻 / 硬科幻");
    expect(MEDIA_CATEGORY_PATH_SEPARATOR).toBe(" / ");
  });

  test("空白名被丢弃，不产生空段", () => {
    expect(mediaCategoryPath([" 电影 ", "", "  "])).toBe("电影");
  });
});

describe("normalizeMediaTags", () => {
  test("去首尾空白、丢弃空串、按首次出现去重", () => {
    expect(normalizeMediaTags([" 4K ", "4K", "科幻", "", "  "])).toEqual(["4K", "科幻"]);
  });

  test("大小写敏感（保留原写法，不做大小写折叠）", () => {
    expect(normalizeMediaTags(["4k", "4K"])).toEqual(["4k", "4K"]);
  });
});

describe("buildMediaCustomData", () => {
  test("三项齐全：输出稀疏投影", () => {
    expect(
      buildMediaCustomData({
        category: { id: "cabc123", name: "科幻", path: "电影 / 科幻" },
        description: " 简介 ",
        tags: ["4K"],
      }),
    ).toEqual({
      category: { id: "cabc123", name: "科幻", path: "电影 / 科幻" },
      description: "简介",
      tags: ["4K"],
    });
  });

  test("空项一律不出现（无分类 / 空描述 / 空标签）", () => {
    expect(buildMediaCustomData({ category: null, description: null, tags: [] })).toEqual({});
    expect(buildMediaCustomData({ category: null, description: "   ", tags: [" "] })).toEqual({});
  });
});
