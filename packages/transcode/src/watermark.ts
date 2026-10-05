// 水印 → ffmpeg 滤镜链编译器（spec.md §10.4 / ADR-0018）
//
// 统一「**全帧水印层 L → 合成**」两段管线，图片 / 文字 × 正常 / 叠加共用同一编译路径：
//   1) 构建与该档输出同尺寸的全帧透明画布 L（`color=black@0.0` + 定位后的水印像素）；
//   2) 合成到视频：normal = `overlay`（标准 alpha）；overlay = `split` + `blend=all_mode=overlay`
//      + `alphaextract` 掩码 + `maskedmerge`（把混合限制在水印像素内）。
//
// 全部为**纯函数**：尺寸换算与（图片）坐标在 argv 编译期以数值产出（Worker 已知该档输出宽高
// 与快照里的 image_width/image_height），只有文字坐标用 drawtext 运行期表达式（text_w/text_h
// 只有运行期可知）。argv 只做数组插值、绝不经 shell（ADR-0008）。
//
// 画布内 alpha=0 区域恒为纯黑（`color=black@0.0`）——「叠加」模式下这点是 maskedmerge 正确性的前提：
// 掩码为 0 处取原画面，画布自身的 RGB 不参与结果。
import { WatermarkParams, WatermarkSnapshot, z } from "@openvod/contracts";
import { WATERMARK_FONT_DIR, type WatermarkAnchor, type WatermarkFont } from "@openvod/shared";

/** 模板参数类型（zod schema 的 infer 结果；注意 TranscodeTemplateParams 同款，值不能直接当类型用） */
export type WatermarkParamsValue = z.infer<typeof WatermarkParams>;
/** 任务快照中的水印段（Worker 只读快照，不回查 watermark_templates） */
export type WatermarkSnapshotValue = z.infer<typeof WatermarkSnapshot>;

export class WatermarkCompileError extends Error {}

/**
 * 合成后交给编码器的像素格式：HLS + H.264/H.265 的目标格式。
 * 必须显式钉住——`overlay=format=auto` 会协商出 yuva420p / yuv444p（带 alpha 或 4:4:4），
 * 既浪费码率又可能不被部分播放器接受。
 */
const OUTPUT_PIX_FMT = "yuv420p";

/** 字体枚举 → Worker 镜像内置 Noto CJK 文件名（键集与 @openvod/shared WATERMARK_FONTS 同源） */
export const WATERMARK_FONT_FILES: Record<WatermarkFont, string> = {
  sans: "NotoSansCJK-Regular.ttc",
  sans_bold: "NotoSansCJK-Bold.ttc",
  serif: "NotoSerifCJK-Regular.ttc",
};

/** 默认字体目录（镜像内置路径；随镜像分发、无环境变量，spec.md §10.6） */
export const WATERMARK_FONT_ROOT = WATERMARK_FONT_DIR;

/** 解析某字体的 fontfile 绝对路径（fontDir 可注入，单测指向本机字体） */
export function watermarkFontFile(font: WatermarkFont, fontDir?: string): string {
  return `${fontDir ?? WATERMARK_FONT_ROOT}/${WATERMARK_FONT_FILES[font]}`;
}

const BACKSLASH = String.fromCharCode(92);
const SINGLE_QUOTE = String.fromCharCode(39);

/**
 * drawtext `text` 值的转义（**唯一**转义入口，纯函数）。
 *
 * ffmpeg 的滤镜 / 选项分词器（av_get_token）在 `-filter_complex` 与选项值上各做一遍拆分，
 * 到达 drawtext 的字面量要穿过这两层 + drawtext 自身的 `%` 展开器，因此规则是逐字符的
 * （规则经 ffmpeg 6.1 逐像素渲染比对标定，见 test/watermark.test.ts）：
 *   `\` → `\\`（两层各吃一个反斜杠）、`%` → `\\%`（到达 drawtext 时须是 `\%`，
 *   否则裸 `%` 触发 `Stray %` 且整段文字不渲染）、`:` → `\:`（选项分隔符）、
 *   `,;[]` → `\c`（滤镜串分隔符）；整串再用单引号包裹。
 *
 * 字面单引号 `'` 无法送达（av_get_token 遇 `'` 即进入引号区且不处理反斜杠），
 * 故契约层已拒绝该字符（spec.md §10.1）。
 */
export function escapeDrawtextText(text: string): string {
  let out = "";
  for (const ch of text) {
    if (ch === BACKSLASH) out += BACKSLASH + BACKSLASH;
    else if (ch === "%") out += BACKSLASH + BACKSLASH + "%";
    else if (ch === ":") out += BACKSLASH + ":";
    else if (ch === "," || ch === ";" || ch === "[" || ch === "]") out += BACKSLASH + ch;
    else out += ch;
  }
  return SINGLE_QUOTE + out + SINGLE_QUOTE;
}

/** 滤镜串中的字面量（fontfile 路径等由 Worker 注入、无引号）；与转义同一套包裹方式 */
function quoteFilterValue(value: string): string {
  return SINGLE_QUOTE + value.split(BACKSLASH).join(BACKSLASH + BACKSLASH) + SINGLE_QUOTE;
}

/** 该档输出尺寸（Worker 的分辨率判定结果，逐档不同） */
export interface WatermarkVariant {
  width: number;
  height: number;
}

export interface WatermarkCompileInput {
  snapshot: WatermarkSnapshotValue;
  /** 图片型：Worker 预签名后的水印图 URL（作为 ffmpeg 第二输入；文字型不需要） */
  imageUrl?: string;
  /** 字体目录（默认镜像内置 Noto CJK 路径；单测可指向本机字体） */
  fontDir?: string;
}

export interface WatermarkFilterPlan {
  /** 主输入之后追加的额外 `-i`（图片型一项；文字型为空数组） */
  extraInputs: string[];
  /** 完整 filter_complex：主输入分支（含既有 scale）+ 水印层 + 合成，输出标签固定为 `[wmwm_out]` */
  filterComplex: string;
}

// ---- 尺寸换算（编译期纯函数） ----

/** 至少 1 px（ffmpeg scale 不接受 0） */
function atLeastOne(v: number): number {
  return Math.max(1, Math.round(v));
}

/**
 * 图片水印的渲染尺寸（spec.md §10.1）：
 * - pixels：两项 = 精确缩放（允许变形）；仅一项 = 按原图宽高比等比换算另一维；
 * - percent：对应维 = 画面宽/高 × 百分比；两项 = 分别按对应边缩放（允许变形）；仅一项 = 等比。
 * 等比换算依赖快照里的 image_width / image_height（管理端上传时 ffprobe 探测回填）。
 */
export function resolveWatermarkImageSize(
  size: Extract<WatermarkParamsValue, { type: "image" }>["size"],
  variant: WatermarkVariant,
  imageWidth: number | null | undefined,
  imageHeight: number | null | undefined,
): { width: number; height: number } {
  const hasW = size.width != null;
  const hasH = size.height != null;
  if (size.mode === "pixels") {
    if (hasW && hasH) return { width: atLeastOne(size.width!), height: atLeastOne(size.height!) };
    if (!imageWidth || !imageHeight) {
      throw new WatermarkCompileError("图片水印缺少原图尺寸（image_width/image_height），无法等比换算");
    }
    if (hasW) return { width: atLeastOne(size.width!), height: atLeastOne((size.width! * imageHeight) / imageWidth) };
    return { width: atLeastOne((size.height! * imageWidth) / imageHeight), height: atLeastOne(size.height!) };
  }
  const w = hasW ? atLeastOne((variant.width * size.width!) / 100) : null;
  const h = hasH ? atLeastOne((variant.height * size.height!) / 100) : null;
  if (w != null && h != null) return { width: w, height: h };
  if (!imageWidth || !imageHeight) {
    throw new WatermarkCompileError("图片水印缺少原图尺寸（image_width/image_height），无法等比换算");
  }
  if (w != null) return { width: w, height: atLeastOne((w * imageHeight) / imageWidth) };
  return { width: atLeastOne((h! * imageWidth) / imageHeight), height: h! };
}

/** 文字水印字号（spec.md §10.1）：pixels = 字号像素；percent = 该档输出高度 × size% */
export function resolveWatermarkFontSize(
  size: Extract<WatermarkParamsValue, { type: "text" }>["size"],
  variant: WatermarkVariant,
): number {
  return size.mode === "pixels" ? size.size : atLeastOne((variant.height * size.size) / 100);
}

// ---- 定位换算（spec.md §10.4 九宫格表） ----

/**
 * 九宫格锚点 + 带符号偏移 → x / y 表达式。
 * `wExpr` / `hExpr` 是水印渲染尺寸的表达式：图片为编译期数值，文字为运行期 `text_w` / `text_h`。
 * 偏移是整数（契约限定），坐标不再自行取整——交给滤镜原生 `trunc` 行为（spec.md §10.4）。
 */
export function anchorExpressions(
  anchor: WatermarkAnchor,
  wExpr: string,
  hExpr: string,
  offsetX: number,
  offsetY: number,
): { x: string; y: string } {
  const sign = (n: number) => (n >= 0 ? `+${n}` : `-${Math.abs(n)}`);
  const dx = offsetX === 0 ? "" : sign(offsetX);
  const dy = offsetY === 0 ? "" : sign(offsetY);
  const right = `main_w-${wExpr}${dx}`;
  const bottom = `main_h-${hExpr}${dy}`;
  const centerX = `(main_w-${wExpr})/2${dx}`;
  const centerY = `(main_h-${hExpr})/2${dy}`;
  switch (anchor) {
    case "top_left":
      return { x: dx === "" ? "0" : dx, y: dy === "" ? "0" : dy };
    case "top_center":
      return { x: centerX, y: dy === "" ? "0" : dy };
    case "top_right":
      return { x: right, y: dy === "" ? "0" : dy };
    case "middle_left":
      return { x: dx === "" ? "0" : dx, y: centerY };
    case "center":
      return { x: centerX, y: centerY };
    case "middle_right":
      return { x: right, y: centerY };
    case "bottom_left":
      return { x: dx === "" ? "0" : dx, y: bottom };
    case "bottom_center":
      return { x: centerX, y: bottom };
    case "bottom_right":
      return { x: right, y: bottom };
  }
}

/** 透明度 → ffmpeg alpha 分量（0–100 → 0–1，保留三位小数避免浮点噪声） */
function alphaValue(opacity: number): string {
  return (Math.round((opacity / 100) * 1000) / 1000).toString();
}

// ---- 滤镜链编译 ----

/** 水印层 L 的滤镜链（输出标签固定 `[wmwm_layer]`）+ 需要的额外输入 */
function buildWatermarkLayer(
  params: WatermarkParamsValue,
  variant: WatermarkVariant,
  input: WatermarkCompileInput,
): { chain: string[]; extraInputs: string[] } {
  const { width: W, height: H } = variant;
  if (W <= 0 || H <= 0) {
    throw new WatermarkCompileError(`水印编译失败：档位输出尺寸非法（${W}×${H}）`);
  }
  // 全帧透明画布：alpha=0 区域恒为纯黑（「叠加」模式下画布 RGB 不参与结果，见文件头注释）
  const chain: string[] = [`color=c=black@0.0:s=${W}x${H}:r=1:d=1,format=rgba[wmwm_base]`];
  const alpha = alphaValue(params.opacity);
  const extraInputs: string[] = [];

  if (params.type === "image") {
    if (!input.imageUrl) {
      throw new WatermarkCompileError(`图片水印「${input.snapshot.name}」缺少图片地址（image_key 未预签名）`);
    }
    const size = resolveWatermarkImageSize(params.size, variant, input.snapshot.image_width, input.snapshot.image_height);
    const pos = anchorExpressions(params.anchor, String(size.width), String(size.height), params.offset_x, params.offset_y);
    // 静态图片作为第二输入（单帧）：画布 overlay 用 shortest=1 收敛为单帧，
    // 再由最终 overlay 的 eof_action=repeat 铺满主输入时长（argv builder 固定此方式）
    extraInputs.push("-i", input.imageUrl);
    chain.push(`[1:v]scale=${size.width}:${size.height},format=rgba,colorchannelmixer=aa=${alpha}[wmwm_img]`);
    chain.push(
      `[wmwm_base][wmwm_img]overlay=${pos.x}:${pos.y}:shortest=1:format=auto[wmwm_layer]`,
    );
  } else {
    const fontSize = resolveWatermarkFontSize(params.size, variant);
    const pos = anchorExpressions(params.anchor, "text_w", "text_h", params.offset_x, params.offset_y);
    const drawtext = [
      `drawtext=fontfile=${quoteFilterValue(watermarkFontFile(params.font, input.fontDir))}`,
      `text=${escapeDrawtextText(params.text)}`,
      `fontsize=${fontSize}`,
      `fontcolor=${params.color}@${alpha}`,
      ...(params.shadow
        ? [
            `shadowcolor=${params.shadow.color}@${alpha}`,
            `shadowx=${params.shadow.offset_x}`,
            `shadowy=${params.shadow.offset_y}`,
          ]
        : []),
      `x=${pos.x}`,
      `y=${pos.y}`,
    ].join(":");
    chain.push(`[wmwm_base]${drawtext}[wmwm_layer]`);
  }
  return { chain, extraInputs };
}

/** 定位摘要（Worker 任务日志用） */
function summarize(params: WatermarkParamsValue): string {
  return [
    params.type === "image" ? "图片" : "文字",
    params.anchor,
    `偏移(${params.offset_x},${params.offset_y})`,
    `透明度${params.opacity}%`,
    params.blend === "overlay" ? "叠加" : "正常",
  ].join(" / ");
}

/**
 * 水印快照 → 人类可读摘要（Worker 任务日志用）：类型 / 锚点 / 偏移 / 透明度 / 混合方式。
 * 参数非法时返回最小摘要（宁可少信息也不要让日志路径抛错）。
 */
export function describeWatermark(snapshot: WatermarkSnapshotValue): string {
  const parsed = WatermarkParams.safeParse(snapshot.params);
  if (!parsed.success) return `${snapshot.name}（${snapshot.type === "image" ? "图片" : "文字"}，参数异常）`;
  return summarize(parsed.data);
}

/**
 * 编译水印滤镜链。
 *
 * @param baseFilter 主输入已有的滤镜（如 `scale=...`）；无则传 null。水印链挂在**缩放之后**，
 *                   且各档按**各自输出分辨率**独立换算（spec.md §10.4）。
 * @returns extraInputs 追加到主输入之后的 `-i`；filterComplex 输出标签固定 `[wmwm_out]`
 */
export function compileWatermarkFilter(
  baseFilter: string | null,
  variant: WatermarkVariant,
  input: WatermarkCompileInput,
): WatermarkFilterPlan {
  const params = WatermarkParams.safeParse(input.snapshot.params);
  if (!params.success) {
    throw new WatermarkCompileError(
      `水印参数非法：${params.error.issues[0]?.path.join(".")} ${params.error.issues[0]?.message}`,
    );
  }
  const p = params.data;
  const { chain: layerChain, extraInputs } = buildWatermarkLayer(p, variant, input);
  const mainChain = baseFilter ? `[0:v]${baseFilter}[wmwm_main]` : "[0:v]null[wmwm_main]";
  const chains = [mainChain, ...layerChain];

  if (p.blend === "overlay") {
    // 全帧逐像素 Overlay 混合，再用 L 的 alpha 作掩码把结果限制在水印像素内。
    // gbrp：无 alpha 的平面 RGB —— blend / maskedmerge 在此格式下按同一掩码混合各平面，
    // 画布 alpha=0 区域为纯黑故无污染；rgba 会因 alpha 平面参与混合而得不到预期结果（实测于 ffmpeg 6.1）。
    chains.push(
      "[wmwm_main]format=gbrp,split=2[wmwm_va][wmwm_vb]",
      "[wmwm_layer]split=2[wmwm_lrgba][wmwm_lalpha]",
      "[wmwm_lrgba]format=gbrp[wmwm_lr]",
      "[wmwm_lalpha]alphaextract,format=gray[wmwm_mask]",
      "[wmwm_va][wmwm_lr]blend=all_mode=overlay[wmwm_blended]",
      `[wmwm_vb][wmwm_blended][wmwm_mask]maskedmerge,format=${OUTPUT_PIX_FMT}[wmwm_out]`,
    );
  } else {
    chains.push(`[wmwm_main][wmwm_layer]overlay=0:0:format=auto,format=${OUTPUT_PIX_FMT}[wmwm_out]`);
  }

  return {
    extraInputs,
    filterComplex: chains.join(";"),
  };
}
