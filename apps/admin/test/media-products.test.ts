// 转码产物按模板归组单测（spec.md §1.3/§1.4）
// 覆盖：新布局（proceed/{id}/{模板id}/）、多模板并存、旧布局兼容、保留段（subtitles）排除、跨媒资不串组；
// 以及按模板删除产物的目标键选择（selectProductObjectKeys，接口 /api/admin/media/[id]/products/[templateId]）。
import { describe, expect, it } from "bun:test";
import { groupProductsByMedia, selectProductObjectKeys } from "../src/lib/media-products";

const o = (key: string, size = 100) => ({ key, size });

describe("proceed 产物按模板归组", () => {
  it("新布局：同一媒资的多套模板产物分别成组，含对象数 / 体积 / 变体", () => {
    const media = "00000123";
    const tplA = "cmu6tpla0001mqe4uoyceqt3";
    const tplB = "cmu6tplb0002mqe4uoyceqt3";
    const map = groupProductsByMedia([
      o(`proceed/${media}/${tplA}/master.m3u8`, 300),
      o(`proceed/${media}/${tplA}/1080p/index.m3u8`, 400),
      o(`proceed/${media}/${tplA}/1080p/seg-00000.ts`, 1000),
      o(`proceed/${media}/${tplA}/720p/index.m3u8`, 200),
      o(`proceed/${media}/${tplA}/720p/seg-00000.ts`, 800),
      o(`proceed/${media}/${tplB}/master.m3u8`, 300),
      o(`proceed/${media}/${tplB}/480p/index.m3u8`, 150),
    ]);

    const products = map.get(media)!;
    expect(products).toHaveLength(2);
    expect(products[0]).toMatchObject({
      templateId: tplA,
      objects: 5,
      bytes: 300 + 400 + 1000 + 200 + 800,
      variants: ["1080p", "720p"],
    });
    expect(products[1]).toMatchObject({ templateId: tplB, objects: 2, variants: ["480p"] });
    // 模板名由 attachTemplateNames 补（此处为纯函数，初始为 null）
    expect(products[0].templateName).toBeNull();
  });

  it("旧布局兼容：无模板段的对象归入空模板 ID（展示为「未分组（旧布局）」）", () => {
    const media = "00000042";
    const map = groupProductsByMedia([
      o(`proceed/${media}/master.m3u8`, 300),
      o(`proceed/${media}/1080p/index.m3u8`, 400),
      o(`proceed/${media}/1080p/seg-00000.ts`, 900),
    ]);
    const products = map.get(media)!;
    expect(products).toHaveLength(1);
    expect(products[0]).toMatchObject({ templateId: "", objects: 3, variants: ["1080p"] });
    expect(products[0].templateName).toBe("未分组（旧布局）");
  });

  it("保留段（subtitles）不参与产物分组", () => {
    const media = "00000042";
    const map = groupProductsByMedia([
      o(`proceed/${media}/subtitles/cmabc0001mqe4uoyceqt3.vtt`),
      o(`proceed/${media}/cmu6tpla0001mqe4uoyceqt3/master.m3u8`),
    ]);
    const products = map.get(media)!;
    expect(products).toHaveLength(1);
    expect(products[0].templateId).toBe("cmu6tpla0001mqe4uoyceqt3");
  });

  it("跨媒资不串组；非 proceed 键被忽略；新布局排在旧布局之前", () => {
    const map = groupProductsByMedia([
      o("original/00000001.mp4"),
      o("cover/00000001/poster.jpg"),
      o("metadata/00000001/probe.json"),
      o("proceed/00000002/1080p/seg-00000.ts"), // 旧布局
      o("proceed/00000001/cmu6tpla0001mqe4uoyceqt3/master.m3u8"),
      o("proceed/00000001/720p/seg-00000.ts"), // 旧布局
    ]);
    expect([...map.keys()].sort()).toEqual(["00000001", "00000002"]);
    const first = map.get("00000001")!;
    expect(first).toHaveLength(2);
    expect(first[0].templateId).toBe("cmu6tpla0001mqe4uoyceqt3"); // 有模板 ID 的在前
    expect(first[1].templateId).toBe(""); // 旧布局兜底在后
    expect(map.get("00000002")!).toHaveLength(1);
  });
});

describe("selectProductObjectKeys（按模板删除的键选择）", () => {
  const media = "00000123";
  const tplA = "cmu6tpla0001mqe4uoyceqt3";
  const tplB = "cmu6tplb0002mqe4uoyceqt3";
  const objs = [
    o(`proceed/${media}/${tplA}/master.m3u8`, 300),
    o(`proceed/${media}/${tplA}/1080p/seg-00000.ts`, 1000),
    o(`proceed/${media}/${tplB}/master.m3u8`, 300),
    o(`proceed/${media}/master.m3u8`, 300), // 旧布局
    o(`proceed/${media}/720p/seg-00000.ts`, 700), // 旧布局
    o(`proceed/${media}/subtitles/cmabc0001mqe4uoyceqt3.vtt`, 50), // 保留段
    o(`proceed/00000999/${tplA}/master.m3u8`, 300), // 跨媒资
    o(`original/${media}.mp4`, 999), // 非 proceed 分区
  ];

  it("按模板：只选该模板子树（其它模板 / 旧布局 / 保留段 / 跨媒资 / original 不动）", () => {
    expect(selectProductObjectKeys(objs, media, tplA).map((x) => x.key)).toEqual([
      `proceed/${media}/${tplA}/master.m3u8`,
      `proceed/${media}/${tplA}/1080p/seg-00000.ts`,
    ]);
  });

  it("旧布局（templateId 为空）：只选无模板段且非保留段的顶层对象", () => {
    expect(selectProductObjectKeys(objs, media, "").map((x) => x.key)).toEqual([
      `proceed/${media}/master.m3u8`,
      `proceed/${media}/720p/seg-00000.ts`,
    ]);
  });

  it("模板不存在 / 无旧布局产物 → 空数组（接口据此返回 404）", () => {
    expect(selectProductObjectKeys(objs, media, "cnotexist0001mqe4uoyceqt3")).toEqual([]);
    expect(selectProductObjectKeys([o(`proceed/${media}/${tplA}/master.m3u8`)], media, "")).toEqual([]);
  });
});
