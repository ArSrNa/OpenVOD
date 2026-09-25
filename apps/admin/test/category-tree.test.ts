// 分类树纯函数单测（spec.md §8.1 / ADR-0016）
// 覆盖：扁平 → 树（无限层级）、路径快照、同级排序、异常数据容错（上级缺失 / 环路）、
// 子树集合与「是否为子孙」判定（移动分类的环路校验依据）。
import { describe, expect, it } from "bun:test";
import {
  buildCategoryLookup,
  buildCategoryTree,
  categoryPathMap,
  categoryRefById,
  collectSubtreeIds,
  compareNodes,
  flattenCategoryTree,
  isDescendantOf,
  pickCategoryRef,
  type CategoryNode,
} from "../src/lib/category-tree";

const n = (id: string, name: string, parentId: string | null, sortOrder = 0): CategoryNode => ({
  id,
  name,
  parentId,
  sortOrder,
});

/** 三层示例：电影 / 科幻 → 硬科幻；电影 / 剧集；纪录片（同级按 sortOrder） */
const NODES: CategoryNode[] = [
  n("c_movie", "电影", null, 1),
  n("c_doc", "纪录片", null, 0),
  n("c_scifi", "科幻", "c_movie", 0),
  n("c_drama", "剧集", "c_movie", 1),
  n("c_hard", "硬科幻", "c_scifi", 0),
];

describe("buildCategoryTree", () => {
  it("无限层级：三层嵌套 + 同级按 sort_order 排序", () => {
    const tree = buildCategoryTree(NODES);
    expect(tree.map((t) => t.name)).toEqual(["纪录片", "电影"]);
    const movie = tree[1];
    expect(movie.children.map((c) => c.name)).toEqual(["科幻", "剧集"]);
    expect(movie.children[0].children.map((c) => c.name)).toEqual(["硬科幻"]);
    expect(movie.depth).toBe(0);
    expect(movie.children[0].depth).toBe(1);
    expect(movie.children[0].children[0].depth).toBe(2);
  });

  it("路径为祖先名 → 自身名（` / ` 连接）", () => {
    const flat = flattenCategoryTree(buildCategoryTree(NODES));
    const byId = new Map(flat.map((f) => [f.id, f.path]));
    expect(byId.get("c_movie")).toBe("电影");
    expect(byId.get("c_hard")).toBe("电影 / 科幻 / 硬科幻");
    expect(byId.get("c_doc")).toBe("纪录片");
  });

  it("上级缺失（脏数据）→ 按顶级处理，节点不消失", () => {
    const tree = buildCategoryTree([n("c_x", "孤儿", "c_missing", 0)]);
    expect(tree).toHaveLength(1);
    expect(tree[0].path).toBe("孤儿");
  });

  it("parent_id 成环 → 截断展开，不栈溢出", () => {
    const tree = buildCategoryTree([
      n("c_a", "A", "c_b", 0),
      n("c_b", "B", "c_a", 0),
    ]);
    // 两个节点互指：都不在 roots（都有存在于列表中的上级），故顶层为空；关键是此处不抛错
    expect(Array.isArray(tree)).toBe(true);
    expect(flattenCategoryTree(tree).length).toBeLessThanOrEqual(2);
  });
});

describe("compareNodes", () => {
  it("sort_order 优先，其次按名称", () => {
    expect(compareNodes(n("a", "b", null, 1), n("b", "a", null, 2))).toBeLessThan(0);
    expect(compareNodes(n("a", "A", null, 0), n("b", "B", null, 0))).toBeLessThan(0);
  });
});

describe("collectSubtreeIds / isDescendantOf", () => {
  it("子树 = 自身 + 全部子孙", () => {
    expect(collectSubtreeIds(NODES, "c_movie").sort()).toEqual(
      ["c_movie", "c_scifi", "c_drama", "c_hard"].sort(),
    );
    expect(collectSubtreeIds(NODES, "c_hard")).toEqual(["c_hard"]);
  });

  it("环路下 collectSubtreeIds 仍能终止", () => {
    const cyclic = [n("c_a", "A", "c_b", 0), n("c_b", "B", "c_a", 0)];
    expect(collectSubtreeIds(cyclic, "c_a").sort()).toEqual(["c_a", "c_b"]);
  });

  it("isDescendantOf：子孙判定（含自身），无关分支为 false", () => {
    expect(isDescendantOf(NODES, "c_hard", "c_movie")).toBe(true);
    expect(isDescendantOf(NODES, "c_movie", "c_movie")).toBe(true);
    expect(isDescendantOf(NODES, "c_doc", "c_movie")).toBe(false);
    expect(isDescendantOf(NODES, "c_movie", "c_hard")).toBe(false);
  });
});

describe("categoryPathMap", () => {
  it("id → 完整路径", () => {
    const map = categoryPathMap(NODES);
    expect(map.get("c_drama")).toBe("电影 / 剧集");
    expect(map.get("c_hard")).toBe("电影 / 科幻 / 硬科幻");
    expect(map.size).toBe(NODES.length);
  });
});

// 默认分类「其他」的解析（spec.md §8.1 修订 2026-09-24）：
// 未设置分类（null）→ 回退默认分类；显式 id 缺失 → 不回退（写入路径必须报错，不能静默改写）
describe("buildCategoryLookup / pickCategoryRef / categoryRefById", () => {
  const withDefault: CategoryNode[] = [...NODES, n("c_other", "其他", null, 10_000)];
  const lookup = buildCategoryLookup(withDefault, "c_other");

  it("未设置分类（null）→ 回退到默认分类「其他」", () => {
    expect(pickCategoryRef(lookup, null)).toEqual({ id: "c_other", name: "其他", path: "其他" });
  });

  it("显式分类优先于默认分类", () => {
    expect(pickCategoryRef(lookup, "c_scifi")).toEqual({
      id: "c_scifi",
      name: "科幻",
      path: "电影 / 科幻",
    });
  });

  it("默认分类缺失时（未初始化）→ null，降级为「未分类」展示", () => {
    const empty = buildCategoryLookup(NODES, null);
    expect(pickCategoryRef(empty, null)).toBeNull();
    expect(pickCategoryRef(empty, "c_movie")?.path).toBe("电影");
  });

  it("categoryRefById 精确解析：id 不存在（或为空）→ null，**不回退默认分类**", () => {
    expect(categoryRefById(lookup, "c_missing")).toBeNull();
    expect(categoryRefById(lookup, null)).toBeNull();
    expect(categoryRefById(lookup, "c_other")?.name).toBe("其他");
  });
});
