// 模板 → ffmpeg 命令编译器（ADR-0014「模板 → ffmpeg 命令编译（必经流程）」）。
// 输入：contracts 校验过的模板结构化参数 + ffprobe 实测源参数（media.probe）；
// 输出：逐档执行计划（跳过判定含在计划中）与 ffmpeg argv 数组。
// 执行判定 = intent.md「转码模板管理」规则 1（只降不升）/ 规则 2（自适应等比缩放）：
//   - 任一维度升格 → 该档跳过；全部持平 → 跳过；存在降级维度且无升格维度 → 执行；
//   - 自适应档：源已在约束内 → 不缩放，视为持平跳过（open-questions #18）；
//   - 模板目标帧率高于源 → 帧率升格跳过；低于源 → 降帧率执行；缺省/源未知 → 保持源帧率。
// argv 只做数组插值，永不经 shell 拼接（ADR-0008 安全边界）；密钥路径仅 Worker 注入。
import {
  TranscodeTemplateParams,
  type TranscodeTemplateParams as TemplateParams,
} from "@openvod/contracts";

/** ffprobe 实测源视频参数（编译的唯一事实来源，来自 media.probe 摘要） */
export interface SourceInfo {
  width: number;
  height: number;
  /** 平均帧率；探测失败为 null（此时无法判定帧率升降，按保持源帧率处理） */
  fps: number | null;
}

/** 单档执行计划：skipped=true 时仅带原因，否则带完整 argv */
export interface VariantPlan {
  /** 变体目录名（主清单 STREAM-INF 引用，如 1080p / 720p） */
  name: string;
  /** 实际输出尺寸（自适应档为等比换算后的值） */
  width: number;
  height: number;
  /** 该档被判定跳过（升格 / 与源持平 / 源已满足自适应约束 / 帧率升格） */
  skipped: boolean;
  skipReason?: string;
  /** ffmpeg argv（不含 ffmpeg 可执行名；skipped 时为 undefined） */
  argv?: string[];
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

/**
 * 计算单档目标尺寸。changed=false 表示与源分辨率持平（是否跳过由帧率维度合并判定）。
 * - fixed：源宽高任一小于目标（升格）→ 跳过；与目标全等 → 持平（不缩放）；
 * - adaptive：源已在全部约束内 → 跳过（无缩放需求，open-questions #18）；否则等比缩放至约束内。
 */
function resolveTargetSize(
  res: TemplateParams["resolutions"][number],
  source: SourceInfo,
): { width: number; height: number; changed: boolean } | { skip: string } {
  if (res.mode === "fixed") {
    if (source.width < res.width || source.height < res.height) {
      return { skip: `升格被拒绝（源 ${source.width}×${source.height} < 目标 ${res.width}×${res.height}）` };
    }
    if (source.width === res.width && source.height === res.height) {
      return { width: res.width, height: res.height, changed: false };
    }
    return { width: res.width, height: res.height, changed: true };
  }
  // adaptive：等比缩放至约束内（intent 规则 2），宽高取更严格者
  const ratios: number[] = [];
  if (res.max_width != null) ratios.push(res.max_width / source.width);
  if (res.max_height != null) ratios.push(res.max_height / source.height);
  if (ratios.every((r) => r >= 1)) {
    return { skip: `源已在自适应约束内（源 ${source.width}×${source.height}）` };
  }
  const ratio = Math.min(...ratios);
  return {
    width: even(source.width * ratio),
    height: even(source.height * ratio),
    changed: true,
  };
}

/** 生成变体目录名（执行档按高度命名，冲突追加序号；跳过档仅用于展示） */
function variantNames(heights: number[]): string[] {
  const used = new Map<string, number>();
  return heights.map((h) => {
    const base = h > 0 ? `${h}p` : "skipped";
    const n = used.get(base) ?? 0;
    used.set(base, n + 1);
    return n === 0 ? base : `${base}-${n + 1}`;
  });
}

function videoArgs(params: TemplateParams): string[] {
  const args: string[] = ["-c:v", params.codec];
  if (params.preset) args.push("-preset", params.preset);
  if (params.crf != null) {
    args.push("-crf", String(params.crf));
  } else if (params.bitrate_kbps != null) {
    args.push(
      "-b:v",
      `${params.bitrate_kbps}k`,
      "-maxrate",
      `${Math.floor(params.bitrate_kbps * 1.07)}k`,
      "-bufsize",
      `${params.bitrate_kbps * 2}k`,
    );
  }
  return args;
}

/**
 * 编译转码模板为逐档执行计划（intent 规则 1/2 判定 + argv 生成）。
 * 跳过档保留在结果中（含原因），供管理端展示与日志追溯；不产 argv。
 */
export function compileTemplate(
  rawParams: unknown,
  source: SourceInfo,
  opts: {
    input: string;
    /** 变体输出目录根（每档写入 {root}/{variantName}/） */
    outRoot: string;
    /** AES-128 key_info 文件路径（ADR-0006）；缺省 = 不加密 */
    keyInfoPath?: string;
    hlsTimeSec?: number;
  },
): VariantPlan[] {
  const params = validateTemplateParams(rawParams);
  const resolved = params.resolutions.map((res) => ({ res, size: resolveTargetSize(res, source) }));

  // 帧率判定（对全部档位一致）：
  //   目标帧率 > 源 = 帧率升格 → 全部跳过；
  //   目标帧率 < 源 = 降帧率执行（写 -r）；持平或源未知 = 保持源帧率（不写 -r）。
  const fpsUpgrade = params.fps != null && source.fps != null && !fpsLte(params.fps, source.fps);
  const fpsDowngrade =
    params.fps != null && source.fps != null && fpsLte(params.fps, source.fps) && params.fps < source.fps;

  const names = variantNames(
    resolved.map(({ size }) => ("skip" in size ? 0 : size.height)),
  );

  return resolved.map(({ res, size }, i) => {
    if ("skip" in size) {
      return {
        name: names[i],
        width: 0,
        height: 0,
        skipped: true,
        skipReason: size.skip,
      };
    }
    if (fpsUpgrade) {
      return {
        name: names[i],
        width: size.width,
        height: size.height,
        skipped: true,
        skipReason: `帧率升格被拒绝（源 ${source.fps}fps < 目标 ${params.fps}fps）`,
      };
    }
    // 全部维度持平（分辨率无变化且无降帧率）→ 无重编码意义，跳过（intent 规则 1）
    if (!size.changed && !fpsDowngrade) {
      return {
        name: names[i],
        width: size.width,
        height: size.height,
        skipped: true,
        skipReason: `与源规格相同（${source.width}×${source.height}${source.fps != null ? `@${source.fps}` : ""}）`,
      };
    }

    const outDir = `${opts.outRoot}/${names[i]}`;
    const argv = [
      "-y",
      "-i", opts.input,
      // 分辨率有变化时等比缩放至目标内（宽高比不变；固定档源 AR 不同时小于目标）
      ...(size.changed
        ? ["-vf", `scale=${size.width}:${size.height}:force_original_aspect_ratio=decrease`]
        : []),
      ...videoArgs(params),
      ...(fpsDowngrade ? ["-r", String(params.fps)] : []),
      "-c:a", "aac",
      "-b:a", `${params.audio_bitrate_kbps}k`,
      "-hls_time", String(opts.hlsTimeSec ?? 6),
      "-hls_playlist_type", "vod",
      "-hls_segment_filename", `${outDir}/seg-%05d.ts`,
      ...(opts.keyInfoPath ? ["-hls_key_info_file", opts.keyInfoPath] : []),
      `${outDir}/index.m3u8`,
    ];
    return { name: names[i], width: size.width, height: size.height, skipped: false, argv };
  });
}

/**
 * 「保持原视频配置」编译（只加密流程）：不重编码，-c copy 重封装 + HLS 切片 + 可选加密。
 * 注：TS 容器要求源视频为 H.264（HEVC 直封可能不可播），校验见 open-questions #19。
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
