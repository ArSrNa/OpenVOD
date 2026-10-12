// 水印模板纯函数单测（spec.md §10 / ADR-0018）：格式魔数识别、参数 schema 校验、
// 预览定位换算与参数摘要。DB / 存储相关逻辑不在本文件覆盖。
import { describe, expect, it } from "bun:test";
import {
  CreateWatermarkRequest,
  UpdateWatermarkRequest,
  WatermarkParams,
} from "@openvod/contracts";
import {
  detectImageFormat,
  WATERMARK_IMAGE_CONTENT_TYPES,
  WATERMARK_IMAGE_EXTS,
} from "../src/lib/watermark-image";
import {
  anchorCss,
  blendCss,
  watermarkParamsSummary,
  watermarkSizeSummary,
} from "../src/lib/watermark-preview";

// ---- 格式魔数识别（spec.md §10.2：按内容识别，与扩展名无关） ----

describe("detectImageFormat", () => {
  const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
  const JPG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1]);
  const WEBP = new TextEncoder().encode("RIFF\x24\x00\x00\x00WEBPVP8 ");

  it("识别 PNG 魔数", () => {
    expect(detectImageFormat(PNG)).toBe("png");
  });

  it("识别 JPEG 魔数", () => {
    expect(detectImageFormat(JPG)).toBe("jpg");
  });

  it("识别 WebP（RIFF/WEBP 容器）魔数", () => {
    expect(detectImageFormat(WEBP)).toBe("webp");
  });

  it("非图片字节流返回 null", () => {
    expect(detectImageFormat(new TextEncoder().encode("hello watermark"))).toBeNull();
  });

  it("过短字节流返回 null", () => {
    expect(detectImageFormat(new Uint8Array([0x89, 0x50]))).toBeNull();
  });

  it("扩展名与 Content-Type 映射完备", () => {
    expect(WATERMARK_IMAGE_EXTS.png).toBe("png");
    expect(WATERMARK_IMAGE_EXTS.jpg).toBe("jpg");
    expect(WATERMARK_IMAGE_EXTS.webp).toBe("webp");
    expect(WATERMARK_IMAGE_CONTENT_TYPES.jpg).toBe("image/jpeg");
  });
});

// ---- 参数 schema（spec.md §10.1：公共参数 + 类型专属，type 判别） ----

const TEXT_PARAMS = {
  type: "text",
  anchor: "bottom_right",
  offset_x: -24,
  offset_y: -24,
  opacity: 80,
  blend: "normal",
  text: "  OpenVOD  ",
  font: "sans_bold",
  color: "#FFFFFF",
  shadow: { color: "#000000", offset_x: 2, offset_y: 2 },
  size: { mode: "pixels", size: 32 },
};

const IMAGE_PARAMS = {
  type: "image",
  anchor: "top_left",
  size: { mode: "percent", width: 10 },
};

describe("WatermarkParams 校验", () => {
  it("文字水印合法参数通过，默认值补齐且 text 归一化 trim", () => {
    const parsed = WatermarkParams.parse({ ...TEXT_PARAMS, offset_x: undefined, offset_y: undefined, opacity: undefined, blend: undefined, shadow: undefined });
    expect(parsed.type).toBe("text");
    if (parsed.type === "text") {
      expect(parsed.offset_x).toBe(0);
      expect(parsed.offset_y).toBe(0);
      expect(parsed.opacity).toBe(100);
      expect(parsed.blend).toBe("normal");
      expect(parsed.shadow).toBeNull();
      expect(parsed.text).toBe("OpenVOD");
    }
  });

  it("图片水印缺省公共参数补默认值", () => {
    const parsed = WatermarkParams.parse({ ...IMAGE_PARAMS });
    expect(parsed.type).toBe("image");
    if (parsed.type === "image") {
      expect(parsed.opacity).toBe(100);
      expect(parsed.blend).toBe("normal");
    }
  });

  it("非法锚点拒绝", () => {
    expect(WatermarkParams.safeParse({ ...TEXT_PARAMS, anchor: "top_middle" }).success).toBe(false);
  });

  it("图片尺寸宽高全空拒绝（至少一项）", () => {
    expect(WatermarkParams.safeParse({ ...IMAGE_PARAMS, size: { mode: "pixels" } }).success).toBe(false);
    expect(WatermarkParams.safeParse({ ...IMAGE_PARAMS, size: { mode: "percent" } }).success).toBe(false);
  });

  it("图片像素尺寸仅宽或仅高允许（等比语义）", () => {
    expect(WatermarkParams.safeParse({ ...IMAGE_PARAMS, size: { mode: "pixels", width: 160 } }).success).toBe(true);
    expect(WatermarkParams.safeParse({ ...IMAGE_PARAMS, size: { mode: "pixels", height: 90 } }).success).toBe(true);
  });

  it("混合方式仅接受 normal / overlay", () => {
    expect(WatermarkParams.safeParse({ ...TEXT_PARAMS, blend: "multiply" }).success).toBe(false);
  });

  it("文字内容含控制字符拒绝", () => {
    expect(WatermarkParams.safeParse({ ...TEXT_PARAMS, text: "a\u0000b" }).success).toBe(false);
  });

  it("颜色格式校验", () => {
    expect(WatermarkParams.safeParse({ ...TEXT_PARAMS, color: "white" }).success).toBe(false);
    expect(WatermarkParams.safeParse({ ...TEXT_PARAMS, color: "#12ff9a" }).success).toBe(true);
  });

  it("字号越界拒绝（4–512 / 1–100）", () => {
    expect(WatermarkParams.safeParse({ ...TEXT_PARAMS, size: { mode: "pixels", size: 3 } }).success).toBe(false);
    expect(WatermarkParams.safeParse({ ...TEXT_PARAMS, size: { mode: "pixels", size: 513 } }).success).toBe(false);
    expect(WatermarkParams.safeParse({ ...TEXT_PARAMS, size: { mode: "percent", size: 101 } }).success).toBe(false);
  });

  it("字体枚举校验", () => {
    expect(WatermarkParams.safeParse({ ...TEXT_PARAMS, font: "comic" }).success).toBe(false);
  });

  it("阴影偏移越界拒绝（±100）", () => {
    expect(
      WatermarkParams.safeParse({ ...TEXT_PARAMS, shadow: { color: "#000000", offset_x: 101, offset_y: 0 } }).success,
    ).toBe(false);
  });
});

describe("CreateWatermarkRequest / UpdateWatermarkRequest", () => {
  it("create 直接使用带 type 判别的 params", () => {
    const parsed = CreateWatermarkRequest.parse({ name: "右下角", params: TEXT_PARAMS });
    expect(parsed.name).toBe("右下角");
    expect(parsed.params.type).toBe("text");
    expect(parsed.description).toBeUndefined();
  });

  it("update 为 partial：仅 name 也可通过", () => {
    const parsed = UpdateWatermarkRequest.parse({ name: "新名字" });
    expect(parsed.name).toBe("新名字");
    expect(parsed.params).toBeUndefined();
  });

  it("名称超长拒绝（≤64）", () => {
    expect(CreateWatermarkRequest.safeParse({ name: "x".repeat(65), params: TEXT_PARAMS }).success).toBe(false);
  });
});

// ---- 预览换算（anchorCss 与 spec.md §10.4 定位换算表等价） ----

describe("anchorCss", () => {
  it("左上锚：left/top 即偏移", () => {
    expect(anchorCss("top_left", -20, 10)).toEqual({ position: "absolute", left: -20, top: 10 });
  });

  it("右上锚：right = −offset_x（负偏移即向内缩进）", () => {
    expect(anchorCss("top_right", -24, 0)).toEqual({ position: "absolute", right: 24, top: 0 });
  });

  it("下居中锚：水平居中 + bottom = −offset_y", () => {
    const css = anchorCss("bottom_center", 5, -10);
    expect(css.left).toBe("calc(50% + 5px)");
    expect(css.transform).toContain("translateX(-50%)");
    expect(css.bottom).toBe(10);
  });

  it("正中心锚：双向居中", () => {
    const css = anchorCss("center", 0, 0);
    expect(css.left).toBe("calc(50% + 0px)");
    expect(css.top).toBe("calc(50% + 0px)");
    expect(css.transform).toBe("translateX(-50%) translateY(-50%)");
  });

  it("左居中锚：left = offset_x + 垂直居中", () => {
    const css = anchorCss("middle_left", 12, -3);
    expect(css.left).toBe(12);
    expect(css.top).toBe("calc(50% + -3px)");
    expect(css.transform).toBe("translateY(-50%)");
  });
});

describe("预览辅助", () => {
  it("混合方式映射 CSS mix-blend-mode", () => {
    expect(blendCss("normal")).toBe("normal");
    expect(blendCss("overlay")).toBe("overlay");
  });

  it("尺寸摘要：图片像素单边标注等比", () => {
    const summary = watermarkSizeSummary({
      type: "image", anchor: "center", offset_x: 0, offset_y: 0, opacity: 100, blend: "normal",
      size: { mode: "pixels", width: 160 },
    } as Parameters<typeof watermarkSizeSummary>[0]);
    expect(summary).toContain("160px");
    expect(summary).toContain("等比");
  });

  it("参数摘要包含位置 / 透明度 / 混合与尺寸", () => {
    const lines = watermarkParamsSummary({
      type: "text", anchor: "bottom_right", offset_x: -24, offset_y: -24, opacity: 80, blend: "overlay",
      text: "OpenVOD", font: "sans_bold", color: "#FFFFFF",
      shadow: { color: "#000000", offset_x: 2, offset_y: 2 },
      size: { mode: "pixels", size: 32 },
    } as Parameters<typeof watermarkParamsSummary>[0]);
    expect(lines.join("\n")).toContain("右下");
    expect(lines.join("\n")).toContain("80%");
    expect(lines.join("\n")).toContain("叠加");
    expect(lines.join("\n")).toContain("32 px");
  });
});
