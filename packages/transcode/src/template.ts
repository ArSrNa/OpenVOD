// 模板 → ffmpeg 命令编译器（ADR-0014「模板 → ffmpeg 命令编译（必经流程）」）。
// 输入：contracts 校验过的模板结构化参数 + ffprobe 实测源参数（media.probe）；
// 输出：逐档执行计划（跳过判定含在计划中）与 ffmpeg argv 数组。
// 执行判定 = intent.md「转码模板管理」规则 1（只降不升、高位取源）/ 规则 2（跳过判定）/
// 规则 3（全档跳过兜底）/ 规则 4（自适应等比缩放），判定维度为 **分辨率 / 帧率 / 码率**（2026-09-18 修订）：
//   - 只降不升、高位取源：低于源的维度按模板执行；**不低于源的维度一律取源值**（不放大 / 不补帧 / 不抬码率）；
//   - 三维度全部不低于源 → 该档跳过（无重编码意义，不产 argv）；跳过档由 Worker 用 compileSourceMatched 兜底出片；
//   - 自适应档：源已在约束内 → 分辨率维度取源值（open-questions #18 已收敛）；
//   - 保持原分辨率档（mode=source，2026-10-05 增）：分辨率维度恒取源值、不写 scale 滤镜，
//     是否执行由帧率 / 码率维度判定（三维度均不低于源则跳过）；仍重编码，与 keep_original（-c copy）不同。
// argv 只做数组插值，永不经 shell 拼接（ADR-0008 安全边界）；密钥路径仅 Worker 注入。
import { TranscodeTemplateParams, z } from "@openvod/contracts";
import { compileWatermarkFilter, type WatermarkSnapshotValue } from "./watermark";

/**
 * 模板结构化参数的 TS 类型（zod schema 的 infer 结果）。
 * 注意：`TranscodeTemplateParams` 是 **zod schema 值**，在类型位置必须经 `z.infer`；
 * 直接 `import type { TranscodeTemplateParams as TemplateParams }` 会把值当类型用（TS2749）。
 */
type TemplateParams = z.infer<typeof TranscodeTemplateParams>;

/** ffprobe 实测源视频参数（编译的唯一事实来源，来自 media.probe 摘要） */
export interface SourceInfo {
  width: number;
  height: number;
  /** 平均帧率；探测失败为 null（此时无法判定帧率升降，按保持源帧率处理） */
  fps: number | null;
  /** 源码率（bps；优先视频轨，缺失回退容器总码率）；未知为 null（无法判定码率升降，按模板码率处理） */
  bitrateBps?: number | null;
}

/** 单档执行计划：skipped=true 时仅带原因，否则带完整 argv */
export interface VariantPlan {
  /** 变体目录名（主清单 STREAM-INF 引用，如 1080p / 720p） */
  name: string;
  /** 实际输出尺寸（自适应档为等比换算后的值；升格 / 持平档取源尺寸） */
  width: number;
  height: number;
  /** 该档被判定跳过（三维度均不低于源：升格被拒取源 / 与源持平 / 源已满足约束 / 帧率与码率均无降级） */
  skipped: boolean;
  skipReason?: string;
  /** ffmpeg argv（不含 ffmpeg 可执行名；skipped 时为 undefined） */
  argv?: string[];
  /** 实际生效的视频码率（kbps；高于源码率时取源码率；CRF 模式或源未知时为 undefined） */
  videoBitrateK?: number;
  /** 该档是「全档跳过」时的源规格兜底产出（分辨率 / 帧率 / 码率保持原视频） */
  fallback?: boolean;
}

export class TemplateCompileError extends Error {}

/** 校验并归一化模板参数（Worker 编译入口的强制第一步，防脏快照） */
export function validateTemplateParams(raw: unknown): TemplateParams {
  const parsed = TranscodeTemplateParams.safeParse(raw);
  if (!parsed.success) {
    throw new TemplateCompileError(
      `模板参数非法：${parsed.error.issues[0]?.path.join(".")} ${parsed.error.issues[0]?.message}`,
    );
  }
  return parsed.data;
}

/** 保留两位小数比较（浮点帧率 29.97 等） */
function fpsLte(a: number, b: number): boolean {
  return Math.round(a * 100) <= Math.round(b * 100);
}

/** 偶数化（H.264/H.265 要求宽高为偶数） */
function even(v: number): number {
  return Math.max(2, Math.floor(v / 2) * 2);
}

/** 分辨率维度的解析结果：scale=true 表示真降级（需要缩放）；note 用于跳过原因展示 */
interface TargetSize {
  width: number;
  height: number;
  /** 是否需要 scale 滤镜（目标分辨率低于源） */
  scale: boolean;
  /** 分辨率未发生真降级时的说明（与源相同 / 升格被拒 / 源已在约束内） */
  note?: string;
}

/**
 * 计算单档目标尺寸（intent 规则 1/4 的分辨率维度，2026-09-18 修订：高位取源值）：
 * - 目标高于源（升格）→ **取源分辨率**（不放大）；
 * - 目标与源一致 → 取源分辨率；
 * - 目标低于源 → 缩放至目标（真降级）；
 * - adaptive：源已在全部约束内 → 取源分辨率（open-questions #18）；
 * - source（保持原分辨率，2026-10-05 增）：恒取源分辨率、不缩放。
 */
function resolveTargetSize(res: TemplateParams["resolutions"][number], source: SourceInfo): TargetSize {
  if (res.mode === "source") {
    return {
      width: source.width,
      height: source.height,
      scale: false,
      note: `保持原分辨率（${source.width}×${source.height}）`,
    };
  }
  if (res.mode === "fixed") {
    if (source.width < res.width || source.height < res.height) {
      return {
        width: source.width,
        height: source.height,
        scale: false,
        note: `升格被拒绝（源 ${source.width}×${source.height} < 目标 ${res.width}×${res.height}，取源分辨率）`,
      };
    }
    if (source.width === res.width && source.height === res.height) {
      return {
        width: source.width,
        height: source.height,
        scale: false,
        note: `与源分辨率相同（${source.width}×${source.height}）`,
      };
    }
    return { width: res.width, height: res.height, scale: true };
  }
  // adaptive：等比缩放至约束内（intent 规则 4），宽高取更严格者
  const ratios: number[] = [];
  if (res.max_width != null) ratios.push(res.max_width / source.width);
  if (res.max_height != null) ratios.push(res.max_height / source.height);
  if (ratios.every((r) => r >= 1)) {
    return {
      width: source.width,
      height: source.height,
      scale: false,
      note: `源已在自适应约束内（源 ${source.width}×${source.height}，取源分辨率）`,
    };
  }
  const ratio = Math.min(...ratios);
  return {
    width: even(source.width * ratio),
    height: even(source.height * ratio),
    scale: true,
  };
}

/** 生成变体目录名（执行档按输出高度命名，冲突追加序号；跳过档仅用于展示，不占目录名） */
function variantNames(heights: number[]): string[] {
  const used = new Map<string, number>();
  return heights.map((h) => {
    const base = h > 0 ? `${h}p` : "skipped";
    const n = used.get(base) ?? 0;
    used.set(base, n + 1);
    return n === 0 ? base : `${base}-${n + 1}`;
  });
}

/** 视频编码参数（effectiveBitrateK = 已按「不高于源码率」归一化后的目标码率；CRF 模式传 null） */
function videoArgs(params: TemplateParams, effectiveBitrateK: number | null): string[] {
  const args: string[] = ["-c:v", params.codec];
  if (params.preset) args.push("-preset", params.preset);
  if (params.crf != null) {
    args.push("-crf", String(params.crf));
  } else if (effectiveBitrateK != null) {
    args.push(
      "-b:v",
      `${effectiveBitrateK}k`,
      "-maxrate",
      `${Math.floor(effectiveBitrateK * 1.07)}k`,
      "-bufsize",
      `${effectiveBitrateK * 2}k`,
    );
  }
  return args;
}

/**
 * 目标视频码率（kbps，码率维度归一化）：
 * - 模板码率 **低于** 源码率 → 按模板（真降级）；
 * - 模板码率 **不低于** 源码率 → 取源码率（不抬码率，遵循原视频）；
 * - 源码率未知或 CRF 模式无目标码率 → 无法比较，按模板原值 / null。
 */
function resolveEffectiveBitrateK(params: TemplateParams, source: SourceInfo): number | null {
  if (params.bitrate_kbps == null) return null;
  if (source.bitrateBps != null && params.bitrate_kbps * 1000 >= source.bitrateBps) {
    return Math.max(1, Math.round(source.bitrateBps / 1000));
  }
  return params.bitrate_kbps;
}

/** 编译选项（compileTemplate / compileSourceMatched 共用） */
export interface CompileOpts {
  input: string;
  /** 变体输出目录根（每档写入 {root}/{variantName}/） */
  outRoot: string;
  /** AES-128 key_info 文件路径（ADR-0006）；缺省 = 不加密 */
  keyInfoPath?: string;
  hlsTimeSec?: number;
  /**
   * 水印快照（spec.md §10.4 / ADR-0018）：非空则该次编译把水印烧录进每档画面。
   * 图片型还需 Worker 注入预签名后的 imageUrl（ffmpeg 第二输入）；字体目录可覆盖（单测）。
   */
  watermark?: { snapshot: WatermarkSnapshotValue; imageUrl?: string; fontDir?: string } | null;
}

/**
 * 把「变体滤镜 + 视频编码参数 + HLS 输出」组装成 argv；水印存在时改走 filter_complex
 * （滤镜链必须挂在缩放之后、编码与切片之前，spec.md §10.4）。
 */
function buildVariantArgv(opts: {
  params: TemplateParams;
  effectiveBitrateK: number | null;
  fpsDowngrade: boolean;
  scaleFilter: string | null;
  outDir: string;
  input: string;
  keyInfoPath?: string;
  hlsTimeSec: number;
  watermark?: CompileOpts["watermark"];
  variant: { width: number; height: number };
}): string[] {
  const codecArgs = videoArgs(opts.params, opts.effectiveBitrateK);
  const tail = [
    ...codecArgs,
    // 仅降帧率时写 -r；升格 / 持平 → 不写（保持源帧率）
    ...(opts.fpsDowngrade ? ["-r", String(opts.params.fps)] : []),
    "-c:a", "aac",
    "-b:a", `${opts.params.audio_bitrate_kbps}k`,
    "-hls_time", String(opts.hlsTimeSec),
    "-hls_playlist_type", "vod",
    "-hls_segment_filename", `${opts.outDir}/seg-%05d.ts`,
    ...(opts.keyInfoPath ? ["-hls_key_info_file", opts.keyInfoPath] : []),
    `${opts.outDir}/index.m3u8`,
  ];

  if (!opts.watermark) {
    return [
      "-y",
      "-i", opts.input,
      ...(opts.scaleFilter ? ["-vf", opts.scaleFilter] : []),
      ...tail,
    ];
  }

  // 水印路径：filter_complex（主输入分支 → 水印层 → 合成），额外输入紧随主输入之后。
  // 必须显式 `-map 0:a?` 带上音频：一旦出现 -map，ffmpeg 对该输出文件的**自动流选择整体失效**
  // （不再自动挑最佳音轨），只映射视频滤镜输出会产出无声视频（2026-10-05 实测踩坑回归守卫）。
  // `?` = 源无音轨时静默忽略；与 compileKeepOriginal 的 `-map 0:a?` 同形态。多音轨源会把
  // 全部音轨带入（自动选择只挑最佳一条），VOD 场景单音轨为常态，两者在此等价。
  const plan = compileWatermarkFilter(opts.scaleFilter, opts.variant, {
    snapshot: opts.watermark.snapshot,
    imageUrl: opts.watermark.imageUrl,
    fontDir: opts.watermark.fontDir,
  });
  return [
    "-y",
    "-i", opts.input,
    ...plan.extraInputs,
    "-filter_complex", plan.filterComplex,
    "-map", "[wmwm_out]",
    "-map", "0:a?",
    ...tail,
  ];
}

/**
 * 编译转码模板为逐档执行计划（intent 规则 1/2 判定 + argv 生成）。
 * 跳过档保留在结果中（含原因），供管理端展示与日志追溯；不产 argv。
 * 三维度（分辨率 / 帧率 / 码率）均不低于源的档位 → 跳过；全档跳过时由 Worker 调 compileSourceMatched 兜底。
 */
export function compileTemplate(rawParams: unknown, source: SourceInfo, opts: CompileOpts): VariantPlan[] {
  const params = validateTemplateParams(rawParams);

  // 帧率维度：目标 > 源 = 升格被拒（取源帧率，不补帧）；目标 < 源 = 降帧率执行（写 -r）；源未知 = 无法判定
  const fpsDowngrade =
    params.fps != null && source.fps != null && fpsLte(params.fps, source.fps) && params.fps < source.fps;
  const fpsUpscaleNote =
    params.fps != null && source.fps != null && !fpsLte(params.fps, source.fps)
      ? `帧率升格被拒绝（源 ${source.fps}fps < 目标 ${params.fps}fps，取源帧率）`
      : null;

  // 码率维度：模板 < 源 = 降码率执行；≥ 源 = 取源码率（不抬码率）
  const bitrateDowngrade =
    params.bitrate_kbps != null && source.bitrateBps != null && params.bitrate_kbps * 1000 < source.bitrateBps;
  const effectiveBitrateK = resolveEffectiveBitrateK(params, source);

  // 判定与命名分两遍：只有执行档才占目录名（跳过档统一为 skipped，不浪费变体名）
  const decisions = params.resolutions.map((res) => {
    const size = resolveTargetSize(res, source);
    return { size, execute: size.scale || fpsDowngrade || bitrateDowngrade };
  });
  const names = variantNames(decisions.map((d) => (d.execute ? d.size.height : 0)));

  return decisions.map(({ size, execute }, i) => {
    const name = names[i];
    // 三维度全部不低于源 → 无重编码意义，跳过（intent 规则 2）
    if (!execute) {
      const notes = [size.note ?? `分辨率与源相同（${source.width}×${source.height}）`];
      notes.push(fpsUpscaleNote ?? "帧率不低于源");
      notes.push(
        params.bitrate_kbps != null && source.bitrateBps != null ? "码率不低于源" : "码率无降级项",
      );
      return {
        name,
        width: size.width,
        height: size.height,
        skipped: true,
        skipReason: `${notes.join("；")} → 无降级维度，无需重编码`,
      };
    }

    const outDir = `${opts.outRoot}/${name}`;
    const argv = buildVariantArgv({
      params,
      effectiveBitrateK,
      fpsDowngrade,
      // 仅分辨率真降级时缩放；升格 / 持平 / 源已满足约束 → 不写 scale（遵循原视频）
      scaleFilter: size.scale
        ? `scale=${size.width}:${size.height}:force_original_aspect_ratio=decrease`
        : null,
      outDir,
      input: opts.input,
      keyInfoPath: opts.keyInfoPath,
      hlsTimeSec: opts.hlsTimeSec ?? 6,
      watermark: opts.watermark,
      variant: { width: size.width, height: size.height },
    });
    return {
      name,
      width: size.width,
      height: size.height,
      skipped: false,
      argv,
      ...(effectiveBitrateK != null ? { videoBitrateK: effectiveBitrateK } : {}),
    };
  });
}

/**
 * 「全档跳过」兜底编译（intent 规则 3，2026-09-18 修订）：
 * 模板三维度均不低于源时本无重编码意义，但**既然配置并发起了转码，就必须出片**——
 * 仍按模板产出单档：编码器 / preset / CRF / 加密按模板，**分辨率、帧率、码率保持原视频**。
 */
export function compileSourceMatched(rawParams: unknown, source: SourceInfo, opts: CompileOpts): VariantPlan {
  const params = validateTemplateParams(rawParams);
  const name = source.height > 0 ? `${source.height}p` : "source";
  const outDir = `${opts.outRoot}/${name}`;
  const effectiveBitrateK = resolveEffectiveBitrateK(params, source);
  const argv = buildVariantArgv({
    params,
    effectiveBitrateK,
    fpsDowngrade: false,
    scaleFilter: null,
    outDir,
    input: opts.input,
    keyInfoPath: opts.keyInfoPath,
    hlsTimeSec: opts.hlsTimeSec ?? 6,
    watermark: opts.watermark,
    variant: { width: source.width, height: source.height },
  });
  return {
    name,
    width: source.width,
    height: source.height,
    skipped: false,
    fallback: true,
    argv,
    ...(effectiveBitrateK != null ? { videoBitrateK: effectiveBitrateK } : {}),
  };
}

/**
 * 「保持原视频配置」编译（只加密流程）：不重编码，-c copy 重封装 + HLS 切片 + 可选加密。
 * 注：TS 容器要求源视频为 H.264（HEVC 直封可能不可播），校验见 open-questions #19。
 * **不支持水印**：-c copy 不解码，无法叠加画面——`keep_original && watermark` 在快照校验
 * 与管理端两层校验均已拒绝（spec.md §10.4），这里不再接受水印入参。
 */
export function compileKeepOriginal(opts: {
  input: string;
  outDir: string;
  keyInfoPath?: string;
  hlsTimeSec?: number;
}): string[] {
  return [
    "-y",
    "-i", opts.input,
    "-map", "0:v:0",
    "-map", "0:a?",
    "-c", "copy",
    "-hls_time", String(opts.hlsTimeSec ?? 6),
    "-hls_playlist_type", "vod",
    "-hls_segment_filename", `${opts.outDir}/seg-%05d.ts`,
    ...(opts.keyInfoPath ? ["-hls_key_info_file", opts.keyInfoPath] : []),
    `${opts.outDir}/index.m3u8`,
  ];
}

export type { TemplateParams };
