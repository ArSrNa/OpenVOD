// 水印滤镜链编译单测（spec.md §10.1 / §10.4；ADR-0018）
//
// 覆盖 ADR-0018「后果与风险」点名的正确性关键路径：两类水印 × 两混合方式 × 九宫格边界
// （负偏移 / 贴边 / 越界）× 等比与变形缩放 × opacity 0/100 × drawtext 转义。
// 转义规则由 ffmpeg 6.1 逐像素渲染比对标定（见「drawtext text 转义」分组注释），此处锁死防回归。
import { describe, expect, test } from "bun:test";
import { INPUT_RW_TIMEOUT_US } from "../src/ffmpeg-input";
import {
  anchorExpressions,
  compileWatermarkFilter,
  describeWatermark,
  escapeDrawtextText,
  resolveWatermarkFontSize,
  resolveWatermarkImageSize,
  watermarkFontFile,
  WatermarkCompileError,
  type WatermarkCompileInput,
  type WatermarkVariant,
} from "../src/watermark";

const VARIANT: WatermarkVariant = { width: 1920, height: 1080 };
const FONT_DIR = "/tmp/fonts";
const B = String.fromCharCode(92);
const Q = String.fromCharCode(39);

function imageSnapshot(over: Record<string, unknown> = {}, meta: Record<string, unknown> = {}): WatermarkCompileInput {
  return {
    snapshot: {
      id: "cwmkimg0000000000000001",
      name: "图片水印",
      type: "image",
      params: {
        type: "image",
        anchor: "bottom_right",
        offset_x: -20,
        offset_y: -20,
        opacity: 100,
        blend: "normal",
        size: { mode: "pixels", width: 120, height: 60 },
        ...over,
      },
      image_key: "watermark/cwmkimg0000000000000001.png",
      image_ext: "png",
      image_width: 240,
      image_height: 120,
      ...meta,
    },
    imageUrl: "https://example.invalid/wm.png",
    fontDir: FONT_DIR,
  } as unknown as WatermarkCompileInput;
}

function textSnapshot(over: Record<string, unknown> = {}): WatermarkCompileInput {
  return {
    snapshot: {
      id: "cwmktext0000000000000002",
      name: "文字水印",
      type: "text",
      params: {
        type: "text",
        anchor: "bottom_right",
        offset_x: -20,
        offset_y: -20,
        opacity: 100,
        blend: "normal",
        text: "OpenVOD",
        font: "sans",
        color: "#ffffff",
        shadow: null,
        size: { mode: "pixels", size: 32 },
        ...over,
      },
    },
    fontDir: FONT_DIR,
  } as unknown as WatermarkCompileInput;
}

// ---- 尺寸换算（编译期纯函数） ----

describe("图片尺寸换算：pixels（两项精确 / 单项等比）", () => {
  test("两项给定时精确缩放（允许变形）", () => {
    expect(resolveWatermarkImageSize({ mode: "pixels", width: 100, height: 300 }, VARIANT, 240, 120)).toEqual({
      width: 100,
      height: 300,
    });
  });

  test("仅给宽 → 按原图宽高比等比换算高", () => {
    expect(resolveWatermarkImageSize({ mode: "pixels", width: 100 }, VARIANT, 240, 120)).toEqual({
      width: 100,
      height: 50,
    });
  });

  test("仅给高 → 按原图宽高比等比换算宽", () => {
    expect(resolveWatermarkImageSize({ mode: "pixels", height: 60 }, VARIANT, 240, 120)).toEqual({
      width: 120,
      height: 60,
    });
  });

  test("缺原图尺寸时单边等比换算直接报错（不猜比例）", () => {
    expect(() => resolveWatermarkImageSize({ mode: "pixels", width: 100 }, VARIANT, null, null)).toThrow(
      WatermarkCompileError,
    );
  });

  test("结果下限 1px（percent=1% 在小档位上仍可用）", () => {
    expect(resolveWatermarkImageSize({ mode: "percent", width: 1 }, { width: 10, height: 10 }, 1, 1).width).toBe(1);
  });
});

describe("图片尺寸换算：percent（占画面比例，逐档按各自输出分辨率）", () => {
  test("仅给宽 → 画面宽 × 百分比，另一维等比", () => {
    expect(resolveWatermarkImageSize({ mode: "percent", width: 20 }, VARIANT, 240, 120)).toEqual({
      width: 384,
      height: 192,
    });
  });

  test("两项给定时分别按对应边缩放（允许变形）", () => {
    expect(resolveWatermarkImageSize({ mode: "percent", width: 10, height: 50 }, VARIANT, 240, 120)).toEqual({
      width: 192,
      height: 540,
    });
  });

  test("逐档独立换算：同一模板在 720p 与 1080p 上得到不同像素尺寸", () => {
    const at1080 = resolveWatermarkImageSize({ mode: "percent", width: 20 }, VARIANT, 240, 120);
    const at720 = resolveWatermarkImageSize({ mode: "percent", width: 20 }, { width: 1280, height: 720 }, 240, 120);
    expect(at1080.width).toBe(384);
    expect(at720.width).toBe(256);
    expect(at720.height).toBe(128);
  });
});

describe("文字字号换算", () => {
  test("pixels：直接取字号像素", () => {
    expect(resolveWatermarkFontSize({ mode: "pixels", size: 48 }, VARIANT)).toBe(48);
  });

  test("percent：输出高度 × size%（取整），逐档不同", () => {
    expect(resolveWatermarkFontSize({ mode: "percent", size: 5 }, VARIANT)).toBe(54);
    expect(resolveWatermarkFontSize({ mode: "percent", size: 5 }, { width: 1280, height: 720 })).toBe(36);
  });
});

// ---- 定位换算（spec.md §10.4 九宫格表） ----

describe("九宫格定位换算表", () => {
  const pos = (anchor: Parameters<typeof anchorExpressions>[0], offX = 0, offY = 0) =>
    anchorExpressions(anchor, "120", "60", offX, offY);

  test("左上：偏移即坐标（零偏移为 0）", () => {
    expect(pos("top_left")).toEqual({ x: "0", y: "0" });
    expect(pos("top_left", 15, -20)).toEqual({ x: "+15", y: "-20" });
  });

  test("上中 / 右下：居中与贴边表达式", () => {
    expect(pos("top_center")).toEqual({ x: "(main_w-120)/2", y: "0" });
    expect(pos("bottom_right")).toEqual({ x: "main_w-120", y: "main_h-60" });
  });

  test("左中 / 正中 / 右中：垂直居中 + 水平三态", () => {
    expect(pos("middle_left")).toEqual({ x: "0", y: "(main_h-60)/2" });
    expect(pos("center", 10, -10)).toEqual({ x: "(main_w-120)/2+10", y: "(main_h-60)/2-10" });
    expect(pos("middle_right")).toEqual({ x: "main_w-120", y: "(main_h-60)/2" });
  });

  test("下中：水平居中 + 贴底", () => {
    expect(pos("bottom_center", 0, -24)).toEqual({ x: "(main_w-120)/2", y: "main_h-60-24" });
  });

  test("右 / 下锚点常配负偏移做内边距（带符号，不取绝对值）", () => {
    expect(pos("bottom_right", -20, -20)).toEqual({ x: "main_w-120-20", y: "main_h-60-20" });
  });

  test("文字用运行期表达式 text_w / text_h（只有运行期可知）", () => {
    expect(anchorExpressions("bottom_center", "text_w", "text_h", 0, -10)).toEqual({
      x: "(main_w-text_w)/2",
      y: "main_h-text_h-10",
    });
  });

  test("正偏移在表达式里带 + 号（可直接拼进算式）", () => {
    expect(pos("top_left", 7, 9)).toEqual({ x: "+7", y: "+9" });
  });
});

// ---- drawtext 转义（规则经 ffmpeg 6.1 逐像素标定，锁死防回归） ----
//
// ffmpeg 的滤镜 / 选项分词器（av_get_token）在 -filter_complex 与选项值上各拆一遍，字面量
// 还要穿过 drawtext 自身的 % 展开器。实测标定结果：整串单引号包裹，`\`→`\\`、`%`→`\\%`、
// `:`→`\:`、`,;[]`→`\c`。字面单引号无法送达（引号区不处理反斜杠），故契约层拒绝该字符。

describe("drawtext text 转义", () => {
  test("整串用单引号包裹", () => {
    expect(escapeDrawtextText("OpenVOD")).toBe(`${Q}OpenVOD${Q}`);
  });

  test("反斜杠 → 两个反斜杠（两层分词各吃一个）", () => {
    expect(escapeDrawtextText("a\\b")).toBe(`${Q}a${B}${B}b${Q}`);
  });

  test("百分号 → 双写反斜杠（到达 drawtext 须为 \\%，裸 % 触发 Stray % 且整段不渲染）", () => {
    expect(escapeDrawtextText("100%")).toBe(`${Q}100${B}${B}%${Q}`);
  });

  test("冒号 → 转义冒号（drawtext 选项分隔符）", () => {
    expect(escapeDrawtextText("a:b")).toBe(`${Q}a${B}:b${Q}`);
  });

  test("逗号 / 分号 / 方括号 → 转义（滤镜串分隔符）", () => {
    expect(escapeDrawtextText("a,b;c[d]e")).toBe(`${Q}a${B},b${B};c${B}[d${B}]e${Q}`);
  });

  test("中文与空格原样保留", () => {
    expect(escapeDrawtextText("官方 水印")).toBe(`${Q}官方 水印${Q}`);
  });
});

describe("fontfile 映射（Worker 镜像内置 Noto CJK）", () => {
  test("默认字体目录来自 @openvod/shared", () => {
    expect(watermarkFontFile("sans")).toBe("/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc");
    expect(watermarkFontFile("sans_bold")).toBe("/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc");
    expect(watermarkFontFile("serif")).toBe("/usr/share/fonts/opentype/noto/NotoSerifCJK-Regular.ttc");
  });

  test("fontDir 可注入（单测与端到端测试指向本机字体）", () => {
    expect(watermarkFontFile("sans", FONT_DIR)).toBe(`${FONT_DIR}/NotoSansCJK-Regular.ttc`);
  });
});

// ---- 滤镜链编译 ----

describe("滤镜链编译：图片水印", () => {
  test("正常模式：画布 → 图片缩放 + 透明度 → overlay 定位 → 合成到视频", () => {
    const plan = compileWatermarkFilter("scale=1280:720", VARIANT, imageSnapshot());
    // 第二输入同样是预签名 URL 网络拉取 → 与主输入一样注入 rw_timeout（2026-10-17）
    expect(plan.extraInputs).toEqual(["-rw_timeout", String(INPUT_RW_TIMEOUT_US), "-i", "https://example.invalid/wm.png"]);
    expect(plan.filterComplex).toContain("[0:v]scale=1280:720[wmwm_main]");
    expect(plan.filterComplex).toContain("color=c=black@0.0:s=1920x1080:r=1:d=1,format=rgba[wmwm_base]");
    expect(plan.filterComplex).toContain("[1:v]scale=120:60,format=rgba,colorchannelmixer=aa=1[wmwm_img]");
    expect(plan.filterComplex).toContain("overlay=main_w-120-20:main_h-60-20:shortest=1:format=auto[wmwm_layer]");
    expect(plan.filterComplex).toContain("[wmwm_main][wmwm_layer]overlay=0:0:format=auto,format=yuv420p[wmwm_out]");
    expect(plan.filterComplex).not.toContain("blend=");
    expect(plan.filterComplex).not.toContain("maskedmerge");
  });

  test("叠加模式：split → blend=all_mode=overlay → alphaextract 掩码 → maskedmerge", () => {
    const plan = compileWatermarkFilter(null, VARIANT, imageSnapshot({ blend: "overlay" }));
    expect(plan.filterComplex).toContain("[wmwm_main]format=gbrp,split=2[wmwm_va][wmwm_vb]");
    expect(plan.filterComplex).toContain("[wmwm_layer]split=2[wmwm_lrgba][wmwm_lalpha]");
    expect(plan.filterComplex).toContain("[wmwm_lalpha]alphaextract,format=gray[wmwm_mask]");
    expect(plan.filterComplex).toContain("[wmwm_va][wmwm_lr]blend=all_mode=overlay[wmwm_blended]");
    expect(plan.filterComplex).toContain(
      "[wmwm_vb][wmwm_blended][wmwm_mask]maskedmerge,format=yuv420p[wmwm_out]",
    );
    expect(plan.filterComplex).toContain("[0:v]null[wmwm_main]");
  });

  test("缺图片地址 → 编译期报错（不产出无水印的片）", () => {
    const input = imageSnapshot();
    delete (input as { imageUrl?: string }).imageUrl;
    expect(() => compileWatermarkFilter(null, VARIANT, input)).toThrow(WatermarkCompileError);
  });

  test("档位尺寸非法 → 编译期报错", () => {
    expect(() => compileWatermarkFilter(null, { width: 0, height: 0 }, imageSnapshot())).toThrow(
      WatermarkCompileError,
    );
  });

  test("脏快照参数 → 编译期报错（不静默忽略水印）", () => {
    const input = imageSnapshot();
    (input.snapshot as { params: Record<string, unknown> }).params = { type: "image", anchor: "nowhere" };
    expect(() => compileWatermarkFilter(null, VARIANT, input)).toThrow(WatermarkCompileError);
  });

  test("比例尺寸逐档换算：同一快照在两档上产出不同 scale 与画布尺寸", () => {
    const at1080 = compileWatermarkFilter(null, VARIANT, imageSnapshot({ size: { mode: "percent", width: 20 } }));
    const at720 = compileWatermarkFilter(
      null,
      { width: 1280, height: 720 },
      imageSnapshot({ size: { mode: "percent", width: 20 } }),
    );
    expect(at1080.filterComplex).toContain("scale=384:192");
    expect(at1080.filterComplex).toContain("s=1920x1080");
    expect(at720.filterComplex).toContain("scale=256:128");
    expect(at720.filterComplex).toContain("s=1280x720");
  });

  test("越界偏移不报错（交给 ffmpeg 按坐标裁剪，spec.md §10.4）", () => {
    const plan = compileWatermarkFilter(null, VARIANT, imageSnapshot({ offset_x: -4096, offset_y: 4096 }));
    expect(plan.filterComplex).toContain("overlay=main_w-120-4096:main_h-60+4096");
  });

  test("opacity 0 / 35 / 100 写入 colorchannelmixer 的 alpha", () => {
    expect(compileWatermarkFilter(null, VARIANT, imageSnapshot({ opacity: 0 })).filterComplex).toContain(
      "colorchannelmixer=aa=0",
    );
    expect(compileWatermarkFilter(null, VARIANT, imageSnapshot({ opacity: 35 })).filterComplex).toContain(
      "colorchannelmixer=aa=0.35",
    );
    expect(compileWatermarkFilter(null, VARIANT, imageSnapshot({ opacity: 100 })).filterComplex).toContain(
      "colorchannelmixer=aa=1",
    );
  });
});

describe("滤镜链编译：文字水印", () => {
  test("画布上直接 drawtext，fontfile / text / 字号 / 颜色齐备；无第二输入", () => {
    const plan = compileWatermarkFilter("scale=1280:720", VARIANT, textSnapshot());
    expect(plan.extraInputs).toEqual([]);
    expect(plan.filterComplex).toContain(
      `drawtext=fontfile='${FONT_DIR}/NotoSansCJK-Regular.ttc':text='OpenVOD':fontsize=32:fontcolor=#ffffff@1`,
    );
    expect(plan.filterComplex).toContain("x=main_w-text_w-20:y=main_h-text_h-20");
    expect(plan.filterComplex).toContain("[wmwm_main][wmwm_layer]overlay=0:0:format=auto,format=yuv420p[wmwm_out]");
  });

  test("阴影开启时追加 shadowcolor / shadowx / shadowy；关闭时完全不出现", () => {
    const on = compileWatermarkFilter(
      null,
      VARIANT,
      textSnapshot({ shadow: { color: "#000000", offset_x: 2, offset_y: -3 } }),
    );
    expect(on.filterComplex).toContain("shadowcolor=#000000@1:shadowx=2:shadowy=-3");
    const off = compileWatermarkFilter(null, VARIANT, textSnapshot());
    expect(off.filterComplex).not.toContain("shadowcolor");
  });

  test("字体枚举 → 对应 fontfile", () => {
    for (const [font, file] of [
      ["sans", "NotoSansCJK-Regular.ttc"],
      ["sans_bold", "NotoSansCJK-Bold.ttc"],
      ["serif", "NotoSerifCJK-Regular.ttc"],
    ] as const) {
      expect(compileWatermarkFilter(null, VARIANT, textSnapshot({ font })).filterComplex).toContain(
        `${FONT_DIR}/${file}`,
      );
    }
  });

  test("含百分号 / 冒号 / 逗号的文字按标定规则转义后进 argv", () => {
    const plan = compileWatermarkFilter(null, VARIANT, textSnapshot({ text: "50%: A,B" }));
    expect(plan.filterComplex).toContain(`text=${Q}50${B}${B}%${B}: A${B},B${Q}`);
  });

  test("文字比例字号逐档换算", () => {
    expect(
      compileWatermarkFilter(null, VARIANT, textSnapshot({ size: { mode: "percent", size: 5 } })).filterComplex,
    ).toContain("fontsize=54");
    expect(
      compileWatermarkFilter(
        null,
        { width: 1280, height: 720 },
        textSnapshot({ size: { mode: "percent", size: 5 } }),
      ).filterComplex,
    ).toContain("fontsize=36");
  });

  test("叠加模式同样走 maskedmerge 把混合限制在水印像素内", () => {
    const plan = compileWatermarkFilter(null, VARIANT, textSnapshot({ blend: "overlay" }));
    expect(plan.filterComplex).toContain("blend=all_mode=overlay");
    expect(plan.filterComplex).toContain("maskedmerge");
  });
});

describe("水印摘要（Worker 任务日志用）", () => {
  test("图片：类型 / 锚点 / 偏移 / 透明度 / 混合", () => {
    expect(describeWatermark(imageSnapshot({ blend: "overlay", opacity: 60 }).snapshot)).toBe(
      "图片 / bottom_right / 偏移(-20,-20) / 透明度60% / 叠加",
    );
  });

  test("文字：同上，混合方式为默认「正常」", () => {
    expect(describeWatermark(textSnapshot({ anchor: "center", offset_x: 0, offset_y: 0 }).snapshot)).toBe(
      "文字 / center / 偏移(0,0) / 透明度100% / 正常",
    );
  });

  test("脏参数不抛错（日志路径不该成为失败原因）", () => {
    const input = imageSnapshot();
    (input.snapshot as { params: unknown }).params = { type: "image" };
    expect(describeWatermark(input.snapshot)).toBe("图片水印（图片，参数异常）");
  });
});
