// 媒资列表排序与筛选单测（intent.md「媒资列表排序与筛选」/ spec.md §3.1，2026-11-15）：
// 展示名 / 大小 / 上传时间排序（时间缺失恒排末尾）、状态 / 分类 / 有无筛选与组合。
import { describe, expect, it } from "bun:test";
import {
  DEFAULT_MEDIA_FILTERS,
  DEFAULT_MEDIA_SORT,
  UNASSIGNED_STATUS,
  filterMediaItems,
  isMediaFilterActive,
  isSameMediaFilters,
  sortMediaItems,
  type MediaListFilters,
  type MediaListViewItem,
} from "../src/lib/media-list-view";

function item(over: Partial<MediaListViewItem> & { id: string }): MediaListViewItem {
  return {
    title: null,
    status: "READY",
    uploadedAt: null,
    lastModified: "2026-01-01T00:00:00.000Z",
    posterKey: null,
    size: 0,
    subtitleCount: 0,
    products: [],
    description: null,
    category: null,
    ...over,
  };
}

function filters(over: Partial<MediaListFilters> = {}): MediaListFilters {
  return { ...DEFAULT_MEDIA_FILTERS, presence: { ...DEFAULT_MEDIA_FILTERS.presence }, ...over };
}

const ids = (items: MediaListViewItem[]) => items.map((i) => i.id);

describe("sortMediaItems", () => {
  it("未选字段时保持服务端顺序（媒资 ID 降序）", () => {
    const items = [item({ id: "00000003" }), item({ id: "00000001" }), item({ id: "00000002" })];
    expect(ids(sortMediaItems(items, DEFAULT_MEDIA_SORT))).toEqual(["00000003", "00000001", "00000002"]);
  });

  it("展示名按 zh-CN 排序，未命名用媒资 ID 兜底", () => {
    const items = [
      item({ id: "00000004", title: "阿凡达" }),
      item({ id: "00000002", title: "蝙蝠侠" }),
      item({ id: "00000001", title: null }),
      item({ id: "00000003", title: "  " }),
    ];
    expect(ids(sortMediaItems(items, { key: "title", order: "asc" }))).toEqual([
      "00000001",
      "00000003",
      "00000004",
      "00000002",
    ]);
    expect(ids(sortMediaItems(items, { key: "title", order: "desc" }))).toEqual([
      "00000002",
      "00000004",
      "00000003",
      "00000001",
    ]);
  });

  it("大小按原视频字节数排序", () => {
    const items = [
      item({ id: "00000001", size: 900 }),
      item({ id: "00000002", size: 50 }),
      item({ id: "00000003", size: 4000 }),
    ];
    expect(ids(sortMediaItems(items, { key: "size", order: "desc" }))).toEqual([
      "00000003",
      "00000001",
      "00000002",
    ]);
    expect(ids(sortMediaItems(items, { key: "size", order: "asc" }))).toEqual([
      "00000002",
      "00000001",
      "00000003",
    ]);
  });

  it("上传时间：自定义优先，未设置回退对象存储写入时间", () => {
    const items = [
      item({ id: "00000001", uploadedAt: "2026-03-01T00:00:00.000Z", lastModified: "2020-01-01T00:00:00.000Z" }),
      item({ id: "00000002", uploadedAt: null, lastModified: "2026-02-01T00:00:00.000Z" }),
      item({ id: "00000003", uploadedAt: "2026-01-01T00:00:00.000Z", lastModified: "2026-09-01T00:00:00.000Z" }),
    ];
    expect(ids(sortMediaItems(items, { key: "uploadedAt", order: "desc" }))).toEqual([
      "00000001",
      "00000002",
      "00000003",
    ]);
  });

  it("时间缺失的项无论升降序都排末尾", () => {
    const items = [
      item({ id: "00000001", uploadedAt: null, lastModified: null }),
      item({ id: "00000002", uploadedAt: "2026-01-01T00:00:00.000Z" }),
      item({ id: "00000003", uploadedAt: "2026-05-01T00:00:00.000Z" }),
    ];
    expect(ids(sortMediaItems(items, { key: "uploadedAt", order: "asc" }))).toEqual([
      "00000002",
      "00000003",
      "00000001",
    ]);
    expect(ids(sortMediaItems(items, { key: "uploadedAt", order: "desc" }))).toEqual([
      "00000003",
      "00000002",
      "00000001",
    ]);
  });

  it("并列时按媒资 ID 降序兜底，顺序稳定", () => {
    const items = [
      item({ id: "00000001", size: 100 }),
      item({ id: "00000003", size: 100 }),
      item({ id: "00000002", size: 100 }),
    ];
    expect(ids(sortMediaItems(items, { key: "size", order: "asc" }))).toEqual([
      "00000003",
      "00000002",
      "00000001",
    ]);
  });
});

describe("filterMediaItems", () => {
  it("未设置筛选时全部返回", () => {
    const items = [item({ id: "00000001" }), item({ id: "00000002", status: null })];
    expect(filterMediaItems(items, DEFAULT_MEDIA_FILTERS, null)).toEqual(items);
  });

  it("状态多选取「或」，含「未入库」", () => {
    const items = [
      item({ id: "00000001", status: "READY" }),
      item({ id: "00000002", status: "FAILED" }),
      item({ id: "00000003", status: "TRANSCODING" }),
      item({ id: "00000004", status: null }),
    ];
    expect(ids(filterMediaItems(items, filters({ statuses: ["READY", "FAILED"] }), null))).toEqual([
      "00000001",
      "00000002",
    ]);
    expect(ids(filterMediaItems(items, filters({ statuses: [UNASSIGNED_STATUS] }), null))).toEqual([
      "00000004",
    ]);
  });

  it("分类按子树 id 集合匹配（含自身与子孙），无分类的媒资不匹配", () => {
    const items = [
      item({ id: "00000001", category: { id: "cat-movie" } }),
      item({ id: "00000002", category: { id: "cat-scifi" } }),
      item({ id: "00000003", category: { id: "cat-doc" } }),
      item({ id: "00000004", category: null }),
    ];
    const scope = new Set(["cat-movie", "cat-scifi"]);
    expect(ids(filterMediaItems(items, filters({ categoryIds: ["cat-movie"] }), scope))).toEqual([
      "00000001",
      "00000002",
    ]);
  });

  it("选中多个分类取并集（子树集合由调用方合并）", () => {
    const items = [
      item({ id: "00000001", category: { id: "cat-movie" } }),
      item({ id: "00000002", category: { id: "cat-doc" } }),
      item({ id: "00000003", category: { id: "cat-other" } }),
    ];
    const scope = new Set(["cat-movie", "cat-scifi", "cat-doc"]);
    expect(
      ids(filterMediaItems(items, filters({ categoryIds: ["cat-movie", "cat-doc"] }), scope)),
    ).toEqual(["00000001", "00000002"]);
  });

  it("有无筛选：字幕 / 封面 / 转码产物 / 描述各三态", () => {
    const items = [
      item({
        id: "00000001",
        subtitleCount: 2,
        posterKey: "cover/00000001/poster.jpg",
        products: [{}],
        description: "有",
      }),
      item({ id: "00000002", description: "  " }),
    ];
    const pick = (key: keyof MediaListFilters["presence"], value: "has" | "none") =>
      ids(filterMediaItems(items, filters({ presence: { ...DEFAULT_MEDIA_FILTERS.presence, [key]: value } }), null));

    expect(pick("subtitles", "has")).toEqual(["00000001"]);
    expect(pick("subtitles", "none")).toEqual(["00000002"]);
    expect(pick("cover", "has")).toEqual(["00000001"]);
    expect(pick("cover", "none")).toEqual(["00000002"]);
    expect(pick("products", "has")).toEqual(["00000001"]);
    expect(pick("products", "none")).toEqual(["00000002"]);
    expect(pick("description", "has")).toEqual(["00000001"]);
    expect(pick("description", "none")).toEqual(["00000002"]);
  });

  it("不同筛选之间取「与」", () => {
    const items = [
      item({ id: "00000001", status: "READY", category: { id: "cat-movie" }, subtitleCount: 1 }),
      item({ id: "00000002", status: "READY", category: { id: "cat-movie" }, subtitleCount: 0 }),
      item({ id: "00000003", status: "FAILED", category: { id: "cat-movie" }, subtitleCount: 1 }),
      item({ id: "00000004", status: "READY", category: { id: "cat-doc" }, subtitleCount: 1 }),
    ];
    const out = filterMediaItems(
      items,
      filters({
        statuses: ["READY"],
        categoryIds: ["cat-movie"],
        presence: { ...DEFAULT_MEDIA_FILTERS.presence, subtitles: "has" },
      }),
      new Set(["cat-movie"]),
    );
    expect(ids(out)).toEqual(["00000001"]);
  });
});

describe("isMediaFilterActive", () => {
  it("默认筛选视为未激活", () => {
    expect(isMediaFilterActive(DEFAULT_MEDIA_FILTERS)).toBe(false);
  });

  it("任一状态 / 分类 / 有无条件即激活", () => {
    expect(isMediaFilterActive(filters({ statuses: ["READY"] }))).toBe(true);
    expect(isMediaFilterActive(filters({ categoryIds: ["cat-1"] }))).toBe(true);
    expect(
      isMediaFilterActive(filters({ presence: { ...DEFAULT_MEDIA_FILTERS.presence, cover: "has" } })),
    ).toBe(true);
  });
});

describe("isSameMediaFilters", () => {
  it("内容相同即等价（表头 onChange 回传全量值时不重置页码）", () => {
    expect(isSameMediaFilters(DEFAULT_MEDIA_FILTERS, filters())).toBe(true);
    expect(
      isSameMediaFilters(
        filters({ statuses: ["READY"], categoryIds: ["cat-1"] }),
        filters({ statuses: ["READY"], categoryIds: ["cat-1"] }),
      ),
    ).toBe(true);
  });

  it("任一字段不同即不等价", () => {
    expect(isSameMediaFilters(DEFAULT_MEDIA_FILTERS, filters({ statuses: ["READY"] }))).toBe(false);
    expect(isSameMediaFilters(filters({ statuses: ["READY"] }), filters({ statuses: ["FAILED"] }))).toBe(
      false,
    );
    expect(isSameMediaFilters(DEFAULT_MEDIA_FILTERS, filters({ categoryIds: ["cat-1"] }))).toBe(false);
    expect(
      isSameMediaFilters(
        DEFAULT_MEDIA_FILTERS,
        filters({ presence: { ...DEFAULT_MEDIA_FILTERS.presence, description: "none" } }),
      ),
    ).toBe(false);
  });
});
