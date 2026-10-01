// 水印参数展示与预览换算（spec.md §10.4 / §10.5）：纯函数、可单测，不依赖 DB / 存储 / React。
// 管理端预览用 CSS 定位渲染，与 ffmpeg 编译期坐标换算共享 §10.4 定位换算表的同一套语义：
// 锚点对齐后施加带符号偏移（x 正 = 右移、y 正 = 下移）。
import type { CSSProperties } from "react";
import type { WatermarkParamsValue } from "@openvod/contracts";
import type { WatermarkAnchor, WatermarkBlendMode, WatermarkFont } from "@openvod/shared";

/** 九宫格锚点展示名（spec.md §10.5） */
export const WATERMARK_ANCHOR_LABELS: Record<WatermarkAnchor, string> = {
  top_left: "左上",
  top_center: "上居中",
  top_right: "右上",
  middle_left: "左居中",
  center: "居中",
  middle_right: "右居中",
  bottom_left: "左下",
  bottom_center: "下居中",
  bottom_right: "右下",
};

/** 混合方式展示名（spec.md §10.1） */
export const WATERMARK_BLEND_LABELS: Record<WatermarkBlendMode, string> = {
  normal: "正常",
  overlay: "叠加",
};

/**
 * 锚点 → CSS 绝对定位（预览用）：与 spec.md §10.4 定位换算表等价——
 *   left 锚：x = off_x → CSS left = off_x
 *   center 锚：x = (W − w)/2 + off_x → CSS left = calc(50% + off_x) + translateX(-50%)
 *   right 锚：x = W − w + off_x → 距右边缘 = −off_x → CSS right = −off_x
 * 垂直方向同理（top / middle / bottom）。负偏移即「向内缩进」。
 */
export function anchorCss(
  anchor: WatermarkAnchor,
  offsetX: number,
  offsetY: number,
): CSSProperties {
  // 「center」无方向前缀 / 后缀，需单列（既是垂直居中也是水平居中）
  const vertical =
    anchor === "center" ? "middle" : anchor.startsWith("top") ? "top" : anchor.startsWith("middle") ? "middle" : "bottom";
  const horizontal = anchor.endsWith("left") ? "left" : anchor.endsWith("right") ? "right" : "center";
  const style: CSSProperties = { position: "absolute" };
  const transform: string[] = [];
  if (horizontal === "left") {
    style.left = offsetX;
  } else if (horizontal === "center") {
    style.left = `calc(50% + ${offsetX}px)`;
    transform.push("translateX(-50%)");
  } else {
    style.right = -offsetX;
  }
  if (vertical === "top") {
    style.top = offsetY;
  } else if (vertical === "middle") {
    style.top = `calc(50% + ${offsetY}px)`;
    transform.push("translateY(-50%)");
  } else {
    style.bottom = -offsetY;
  }
  if (transform.length) style.transform = transform.join(" ");
  return style;
}

/** 混合方式 → CSS mix-blend-mode（预览示意；ffmpeg 侧映射见 spec.md §10.4） */
export function blendCss(blend: WatermarkBlendMode): CSSProperties["mixBlendMode"] {
  return blend === "overlay" ? "overlay" : "normal";
}

/**
 * 字体枚举 → 浏览器预览字体（Worker 镜像内置 Noto CJK；浏览器侧以同族字体近似渲染，
 * 成像一致性由参数语义保证，spec.md §10.5「服务端不渲染预览图」）。
 */
export const WATERMARK_FONT_CSS: Record<WatermarkFont, { fontFamily: string; fontWeight: number }> = {
  sans: {
    fontFamily: "'Noto Sans SC','Noto Sans CJK SC','Source Han Sans SC','PingFang SC','Microsoft YaHei',sans-serif",
    fontWeight: 400,
  },
  sans_bold: {
    fontFamily: "'Noto Sans SC','Noto Sans CJK SC','Source Han Sans SC','PingFang SC','Microsoft YaHei',sans-serif",
    fontWeight: 700,
  },
  serif: {
    fontFamily: "'Noto Serif SC','Noto Serif CJK SC','Source Han Serif SC','SimSun',serif",
    fontWeight: 400,
  },
};

/** 尺寸摘要（列表参数列；image 为宽×高或百分比，text 为字号） */
export function watermarkSizeSummary(params: WatermarkParamsValue): string {
  if (params.type === "text") {
    const size = params.size;
    return size.mode === "pixels"
      ? `字号 ${size.size} px`
      : `字号 ${size.size}% 画面高`;
  }
  const size = params.size;
  if (size.mode === "pixels") {
    const w = size.width != null ? `${size.width}px` : "auto";
    const h = size.height != null ? `${size.height}px` : "auto";
    const ratio = size.width != null && size.height != null ? "" : "（单边等比）";
    return `尺寸 ${w} × ${h}${ratio}`;
  }
  const parts: string[] = [];
  if (size.width != null) parts.push(`宽 ${size.width}%`);
  if (size.height != null) parts.push(`高 ${size.height}%`);
  const ratio = size.width != null && size.height != null ? "" : "（单边等比）";
  return `尺寸 ${parts.join("，")}${ratio}`;
}

/** 模板参数摘要（列表「参数」列，spec.md §10.5） */
export function watermarkParamsSummary(params: WatermarkParamsValue): string[] {
  const lines: string[] = [];
  if (params.type === "text") {
    lines.push(`文字「${params.text}」· 颜色 ${params.color}`);
    lines.push(`字体：${fontLabel(params.font)}${params.shadow ? " · 含阴影" : ""}`);
  }
  const offset =
    params.offset_x === 0 && params.offset_y === 0
      ? ""
      : `（x ${formatSigned(params.offset_x)}，y ${formatSigned(params.offset_y)}）`;
  lines.unshift(
    `位置：${WATERMARK_ANCHOR_LABELS[params.anchor]}${offset} · 透明度 ${params.opacity}%`,
  );
  lines.push(`混合：${WATERMARK_BLEND_LABELS[params.blend]}`);
  lines.push(watermarkSizeSummary(params));
  return lines;
}

function fontLabel(font: WatermarkFont): string {
  switch (font) {
    case "sans":
      return "黑体";
    case "sans_bold":
      return "黑体加粗";
    case "serif":
      return "宋体";
  }
}

function formatSigned(n: number): string {
  return n > 0 ? `+${n}` : String(n);
}
