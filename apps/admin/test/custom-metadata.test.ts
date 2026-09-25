// 自定义元数据投影纯函数单测（spec.md §8.3 / ADR-0016）
// 覆盖：标签解析容错、稀疏投影（空项删除）、白名单外扩展键保留、描述 / 标签归一化。
import { describe, expect, it } from "bun:test";
import { mergeCustomData, parseMediaTags, serializeCustomData } from "../src/lib/custom-metadata";

describe("parseMediaTags", () => {
  it("非数组 / 非法元素 → 空数组或仅保留合法项", () => {
    expect(parseMediaTags(null)).toEqual([]);
    expect(parseMediaTags(undefined)).toEqual([]);
    expect(parseMediaTags("4K")).toEqual([]);
    expect(parseMediaTags({ a: 1 })).toEqual([]);
    expect(parseMediaTags(["4K", 42, null, " 科幻 ", ""])).toEqual(["4K", "科幻"]);
  });
});

describe("mergeCustomData", () => {
  it("三项齐全：写入稀疏投影（保留分类快照）", () => {
    const out = mergeCustomData(null, {
      category: { id: "cabc123", name: "科幻", path: "电影 / 科幻" },
      description: "  简介  ",
      tags: [" 4K ", "4K", "科幻", " "],
    });
    expect(out).toEqual({
      category: { id: "cabc123", name: "科幻", path: "电影 / 科幻" },
      description: "简介",
      tags: ["4K", "科幻"],
    });
  });

  it("空项不出现在投影里（空描述 / 空标签 / 无分类）", () => {
    expect(mergeCustomData(null, { category: null, description: "  ", tags: [] })).toEqual({});
    expect(
      mergeCustomData({ description: "旧描述", tags: ["旧"] }, {
        category: null,
        description: null,
        tags: [],
      }),
    ).toEqual({});
  });

  it("白名单外的扩展键原样保留（不被一次元数据保存抹掉）", () => {
    const out = mergeCustomData(
      { internal_note: "运维备注", owner: "ops", description: "旧" },
      { category: null, description: "新", tags: ["4K"] },
    );
    expect(out).toEqual({ internal_note: "运维备注", owner: "ops", description: "新", tags: ["4K"] });
  });

  it("既有值非对象（脏数据）→ 视为空对象，不抛错", () => {
    expect(mergeCustomData("oops", { category: null, description: null, tags: [] })).toEqual({});
    expect(mergeCustomData(["a"], { category: null, description: "x", tags: [] })).toEqual({
      description: "x",
    });
  });
});

describe("serializeCustomData", () => {
  it("导出 2 空格缩进 JSON（metadata/{id}/custom.json 内容）", () => {
    expect(serializeCustomData({ tags: ["4K"] })).toBe('{\n  "tags": [\n    "4K"\n  ]\n}');
  });
});
