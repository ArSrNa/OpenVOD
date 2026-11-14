// 媒资级转码产物展示与默认设置单测（spec.md §6.3/§11.1，2026-11-15）：
// JSON 解析容错、可见产物计算、展示开关（至少保留一套）、默认产物切换。
import { describe, expect, it } from "bun:test";
import {
  DEFAULT_MEDIA_PRODUCT_SETTINGS,
  parseMediaProductSettings,
  serializeMediaProductSettings,
  setDefaultProduct,
  toggleProductVisibility,
  visibleProducts,
} from "../src/lib/media-product-settings";

const A = "caaaaaaaaaaaaaaaaaaaa";
const B = "cbbbbbbbbbbbbbbbbbbbb";
const C = "cccccccccccccccccccc";

describe("parseMediaProductSettings", () => {
  it("空值 / 非法值降级为全部展示、无媒资级默认", () => {
    for (const raw of [null, undefined, "x", [], 1, {}, { visible_template_ids: "all" }]) {
      expect(parseMediaProductSettings(raw)).toEqual(DEFAULT_MEDIA_PRODUCT_SETTINGS);
    }
  });

  it("白名单去重并丢弃非模板 ID 形状的脏值", () => {
    expect(
      parseMediaProductSettings({
        visible_template_ids: [A, A, "bad", B],
        default_template_id: "bad",
      }),
    ).toEqual({ visibleTemplateIds: [A, B], defaultTemplateId: null });
  });

  it("空数组等价于全部展示（null）", () => {
    expect(parseMediaProductSettings({ visible_template_ids: [] })).toEqual(
      DEFAULT_MEDIA_PRODUCT_SETTINGS,
    );
  });

  it("默认产物不在白名单内时不生效", () => {
    expect(
      parseMediaProductSettings({
        visible_template_ids: [A],
        default_template_id: B,
      }),
    ).toEqual({ visibleTemplateIds: [A], defaultTemplateId: null });
  });

  it("合法设置原样保留，序列化回 snake_case", () => {
    const settings = parseMediaProductSettings({
      visible_template_ids: [A, B],
      default_template_id: B,
    });
    expect(serializeMediaProductSettings(settings)).toEqual({
      visible_template_ids: [A, B],
      default_template_id: B,
    });
  });
});

describe("visibleProducts", () => {
  it("未设置白名单 = 全部产物", () => {
    expect(visibleProducts(DEFAULT_MEDIA_PRODUCT_SETTINGS, [A, B, C])).toEqual([A, B, C]);
  });

  it("按白名单过滤，且保持产物传入顺序", () => {
    expect(
      visibleProducts({ visibleTemplateIds: [C, A], defaultTemplateId: null }, [A, B, C]),
    ).toEqual([A, C]);
  });

  it("白名单与现存产物无交集时回退全部（至少一套可播）", () => {
    expect(
      visibleProducts({ visibleTemplateIds: ["cdddddddddddddddddddd"], defaultTemplateId: null }, [
        A,
        B,
      ]),
    ).toEqual([A, B]);
  });
});

describe("toggleProductVisibility", () => {
  it("关闭其中一套 → 白名单只留其余产物", () => {
    expect(
      toggleProductVisibility(DEFAULT_MEDIA_PRODUCT_SETTINGS, [A, B, C], B, false),
    ).toEqual({ visibleTemplateIds: [A, C], defaultTemplateId: null });
  });

  it("重新打开后覆盖全部产物 → 归一化为全部展示", () => {
    const hidden = { visibleTemplateIds: [A, C], defaultTemplateId: null };
    expect(toggleProductVisibility(hidden, [A, B, C], B, true)).toEqual(
      DEFAULT_MEDIA_PRODUCT_SETTINGS,
    );
  });

  it("拒绝关闭最后一套展示产物", () => {
    expect(
      toggleProductVisibility(
        { visibleTemplateIds: [A], defaultTemplateId: A },
        [A, B, C],
        A,
        false,
      ),
    ).toBeNull();
  });

  it("关闭默认产物时同时取消默认", () => {
    expect(
      toggleProductVisibility({ visibleTemplateIds: [A, B], defaultTemplateId: A }, [A, B], A, false),
    ).toEqual({ visibleTemplateIds: [B], defaultTemplateId: null });
  });

  it("关闭非默认产物时保留默认", () => {
    expect(
      toggleProductVisibility({ visibleTemplateIds: [A, B], defaultTemplateId: A }, [A, B], B, false),
    ).toEqual({ visibleTemplateIds: [A], defaultTemplateId: A });
  });
});

describe("setDefaultProduct", () => {
  it("设置展示范围内的产物为默认", () => {
    expect(setDefaultProduct(DEFAULT_MEDIA_PRODUCT_SETTINGS, [A, B], B)).toEqual({
      visibleTemplateIds: null,
      defaultTemplateId: B,
    });
  });

  it("隐藏的产物不能设为默认", () => {
    expect(
      setDefaultProduct({ visibleTemplateIds: [A], defaultTemplateId: null }, [A, B], B),
    ).toBeNull();
  });

  it("null = 取消媒资级默认（回退全局默认模板）", () => {
    expect(setDefaultProduct({ visibleTemplateIds: [A], defaultTemplateId: A }, [A], null)).toEqual({
      visibleTemplateIds: [A],
      defaultTemplateId: null,
    });
  });
});
