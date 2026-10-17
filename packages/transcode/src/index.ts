// ffmpeg / ffprobe 封装（ADR-0008）：argv 数组模板，永不经 shell 拼接（防注入）
// 密钥文件路径仅 Worker 注入；执行带超时；fMP4/CENC 演进时在此追加 Shaka Packager 调用。
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

export class FFmpegError extends Error {
  constructor(
    public argv: string[],
    public stderr: string,
  ) {
    super(`ffmpeg 失败（exit 非零）：${stderr.slice(-500)}`);
  }
}

/** 单次进度更新（argv 由模板编译器注入 `-progress pipe:1`，Worker 解析 stdout 得到） */
export interface FFmpegProgressInfo {
  /** 已输出时长（微秒）。ffmpeg 的 `out_time_ms` 字段实为微秒（历史命名），与 `out_time_us` 同口径 */
  outTimeUs: number;
}

export interface RunFFmpegOptions {
  /** 兜底超时（毫秒），默认 6 小时；超时即 SIGKILL 并按失败处理 */
  timeoutMs?: number;
  /** 进度回调（仅在 argv 带 `-progress pipe:1` 时有值） */
  onProgress?: (info: FFmpegProgressInfo) => void;
}

/** stderr 只保尾部（失败消息取末 500 字符；避免长任务把内存吃满） */
const STDERR_KEEP_CHARS = 256 * 1024;

/**
 * 执行一次 ffmpeg：argv 直传 spawn（不经 shell，ADR-0008 安全边界）。
 * 用 spawn 而非 execFile 是为了**流式**读 `-progress pipe:1` 的 stdout（execFile 只能在退出后拿到全部输出）——
 * 进度是「转码中 x%」的唯一来源（spec.md §5.1）。
 */
export async function runFFmpeg(argv: string[], opts: RunFFmpegOptions = {}): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 6 * 3600_000;
  await new Promise<void>((resolve, reject) => {
    const child = spawn("ffmpeg", argv, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    let stdoutRest = "";
    let settled = false;

    const timer = setTimeout(() => {
      stderr += `\n[runFFmpeg] 超时 ${timeoutMs}ms，已终止`;
      child.kill("SIGKILL");
    }, timeoutMs);
    timer.unref?.();

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (!opts.onProgress) return;
      stdoutRest += chunk;
      const lines = stdoutRest.split("\n");
      stdoutRest = lines.pop() ?? "";
      for (const line of lines) {
        const m = /^out_time_(?:us|ms)=(\d+)$/.exec(line.trim());
        if (m) opts.onProgress({ outTimeUs: Number(m[1]) });
      }
    });

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
      if (stderr.length > STDERR_KEEP_CHARS) stderr = stderr.slice(-STDERR_KEEP_CHARS);
    });

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    child.on("error", (e) => finish(() => reject(new FFmpegError(argv, `${stderr}\n${String(e)}`))));
    child.on("close", (code) => finish(() => (code === 0 ? resolve() : reject(new FFmpegError(argv, stderr)))));
  });
}

// ---- ffprobe 系统元数据（spec.md §1.3 `metadata/{id}/probe.json`；管理端「生成元数据」/ Worker 探测共用） ----

/** ffprobe -show_streams 单条流（保留原始字段名，probe.json 即原始 ffprobe JSON） */
export interface FFprobeStream {
  index?: number;
  codec_name?: string;
  codec_long_name?: string;
  profile?: string;
  codec_type?: string; // video / audio / subtitle / data ...
  codec_tag_string?: string;
  width?: number;
  height?: number;
  coded_width?: number;
  coded_height?: number;
  /** 像素格式（yuv420p / yuv420p10le ...） */
  pix_fmt?: string;
  /** 平均帧率（"30000/1001" 分数形式） */
  avg_frame_rate?: string;
  /** 基础帧率（编码层） */
  r_frame_rate?: string;
  sample_aspect_ratio?: string;
  display_aspect_ratio?: string;
  color_range?: string; // tv / pc
  /** 色彩空间 / 矩阵系数（bt709 / bt2020nc ...） */
  color_space?: string;
  /** 色彩传输特性（bt709 / smpte2084 / arib-std-b67 ...） */
  color_transfer?: string;
  /** 色彩原色（bt709 / bt2020 ...） */
  color_primaries?: string;
  /** 位深（8 / 10，缺省时按 pix_fmt 推断） */
  bits_per_raw_sample?: string;
  bit_rate?: string;
  nb_frames?: string;
  sample_fmt?: string;
  sample_rate?: string;
  channels?: number;
  channel_layout?: string;
  duration?: string;
  disposition?: Record<string, number>;
  tags?: Record<string, string>;
}

/** ffprobe -show_format 容器段 */
export interface FFprobeFormat {
  filename?: string;
  /** 容器封装（mov,mp4,m4a,3gp,3g2,mj2 ...） */
  format_name?: string;
  format_long_name?: string;
  /** 秒（字符串） */
  duration?: string;
  size?: string;
  bit_rate?: string;
  nb_streams?: number;
  nb_programs?: number;
  start_time?: string;
  tags?: Record<string, string>;
}

/** ffprobe 原始输出（-print_format json -show_format -show_streams） */
export interface ProbeResult {
  streams?: FFprobeStream[];
  format?: FFprobeFormat;
}

export async function ffprobeJSON(input: string, timeoutMs = 120_000): Promise<ProbeResult> {
  const { stdout } = await execFileP(
    "ffprobe",
    ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", input],
    { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 },
  );
  return JSON.parse(stdout) as ProbeResult;
}

/** 解析 ffprobe 分数帧率（"30000/1001" → 29.97）；非法返回 null */
function parseRate(rate?: string): number | null {
  if (!rate) return null;
  const m = /^(\d+)\/(\d+)$/.exec(rate.trim());
  const [num, den] = m ? [Number(m[1]), Number(m[2])] : [Number(rate), 1];
  if (!Number.isFinite(num) || !Number.isFinite(den) || den === 0 || num === 0) return null;
  return Math.round((num / den) * 1000) / 1000;
}

function numOr(v: string | number | undefined, scale = 1): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * scale) || null : null;
}

// yuv420p10le / yuv444p12le 等后缀数字即位深；p010le 特殊（10bit）
const PIXFMT_DEPTH_RE = /(\d{2})(?:le|be)?$/;
function pixFmtDepth(pixFmt?: string): number | null {
  if (!pixFmt) return null;
  if (pixFmt.startsWith("p010")) return 10;
  const m = PIXFMT_DEPTH_RE.exec(pixFmt);
  return m ? Number(m[1]) : null;
}

/** 视频流摘要（宽高 / 帧率 / 色彩空间 / 编码，spec「生成元数据」核心字段） */
export interface ProbeVideoSummary {
  codec: string | null;
  profile: string | null;
  pixFmt: string | null;
  bitDepth: number | null;
  width: number | null;
  height: number | null;
  /** 平均帧率（fps，数值）；解析失败为 null */
  fps: number | null;
  /** ffprobe 原始帧率分数（"30000/1001"），供精确还原 */
  frameRate: string | null;
  /** 色彩空间（矩阵系数） */
  colorSpace: string | null;
  colorTransfer: string | null;
  colorPrimaries: string | null;
  /** 色彩量化范围（tv / pc） */
  colorRange: string | null;
  bitrate: number | null;
  frameCount: number | null;
}

export interface ProbeAudioSummary {
  codec: string | null;
  profile: string | null;
  sampleRate: number | null;
  channels: number | null;
  channelLayout: string | null;
  bitrate: number | null;
}

/** 归一化探测摘要：入库 media.probe（Json），详情弹窗结构化展示用 */
export interface ProbeSummary {
  /** 容器封装格式（ffprobe format_name） */
  container: string | null;
  durationMs: number | null;
  /** 总码率（bps） */
  bitrate: number | null;
  sizeBytes: number | null;
  /** 总流数 */
  streamCount: number | null;
  video: ProbeVideoSummary | null;
  /** 可能存在多音轨，按流顺序保留 */
  audio: ProbeAudioSummary[];
  /** 字幕流条数 */
  subtitleCount: number;
}

/** 从 ffprobe 原始输出提取摘要（取分辨率最高的视频流为主轨，音轨全保留） */
export function summarizeProbe(probe: ProbeResult): ProbeSummary {
  const streams = probe.streams ?? [];
  const videos = streams.filter((s) => s.codec_type === "video");
  const main =
    videos.slice().sort((a, b) => (b.width ?? 0) * (b.height ?? 0) - (a.width ?? 0) * (a.height ?? 0))[0] ?? null;

  const video: ProbeVideoSummary | null = main
    ? {
        codec: main.codec_name ?? null,
        profile: main.profile ?? null,
        pixFmt: main.pix_fmt ?? null,
        bitDepth: numOr(main.bits_per_raw_sample) ?? pixFmtDepth(main.pix_fmt),
        width: main.width ?? null,
        height: main.height ?? null,
        fps: parseRate(main.avg_frame_rate) ?? parseRate(main.r_frame_rate),
        frameRate: main.avg_frame_rate ?? main.r_frame_rate ?? null,
        colorSpace: main.color_space ?? null,
        colorTransfer: main.color_transfer ?? null,
        colorPrimaries: main.color_primaries ?? null,
        colorRange: main.color_range ?? null,
        bitrate: numOr(main.bit_rate),
        frameCount: numOr(main.nb_frames),
      }
    : null;

  const audio = streams
    .filter((s) => s.codec_type === "audio")
    .map<ProbeAudioSummary>((s) => ({
      codec: s.codec_name ?? null,
      profile: s.profile ?? null,
      sampleRate: numOr(s.sample_rate),
      channels: s.channels ?? null,
      channelLayout: s.channel_layout ?? null,
      bitrate: numOr(s.bit_rate),
    }));

  return {
    container: probe.format?.format_name ?? null,
    durationMs: numOr(probe.format?.duration, 1000),
    bitrate: numOr(probe.format?.bit_rate),
    sizeBytes: numOr(probe.format?.size),
    streamCount: probe.format?.nb_streams ?? streams.length,
    video,
    audio,
    subtitleCount: streams.filter((s) => s.codec_type === "subtitle").length,
  };
}

// ---- 默认 ladder（ADR-0008 表格） ----
export interface LadderEntry {
  name: string; // variant 目录名
  width: number;
  height: number;
  videoBitrateK: number;
  audioBitrateK: number;
}

export const DEFAULT_LADDER: LadderEntry[] = [
  { name: "1080p", width: 1920, height: 1080, videoBitrateK: 5000, audioBitrateK: 128 },
  { name: "720p", width: 1280, height: 720, videoBitrateK: 2800, audioBitrateK: 128 },
  { name: "480p", width: 854, height: 480, videoBitrateK: 1400, audioBitrateK: 96 },
];

/**
 * HLS AES-128 key_info 文件内容（三行，ADR-0006 §2）：
 *   1) 密钥 URI（转码期占位，分发时由 m3u8 改写替换）
 *   2) 本地 16B CEK 文件路径（任务结束即清理）
 *   3) 显式 IV（**纯 hex，不带 0x 前缀**）
 *
 * 第三行不能带 `0x`：ffmpeg 会原样取用该字符串并在清单里自行加前缀，
 * 带上就会产出 `EXT-X-KEY:...IV=0x0x…` 并报
 * `Error setting option encryption_iv`（加密失败，分片不产出）——实测于 ffmpeg 6.1。
 */
export function buildKeyInfoFile(opts: {
  keyUriPlaceholder: string;
  cekFilePath: string;
  ivHex: string;
}): string {
  const iv = opts.ivHex.toLowerCase().replace(/^0x/, "");
  return `${opts.keyUriPlaceholder}\n${opts.cekFilePath}\n${iv}\n`;
}

/** 单档转码 ffmpeg argv（TS + AES-128，ADR-0006/0008；完整 preset/override 机制 specification 落地） */
export function planHlsArgs(opts: {
  input: string;
  outDir: string;
  entry: LadderEntry;
  keyInfoPath: string;
  hlsTimeSec?: number;
}): string[] {
  const { input, outDir, entry, keyInfoPath } = opts;
  return [
    "-y",
    "-i", input,
    // 视频档（ADR-0008 默认 ladder）
    "-vf", `scale=-2:${entry.height}`,
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-b:v", `${entry.videoBitrateK}k`,
    "-maxrate", `${Math.floor(entry.videoBitrateK * 1.07)}k`,
    "-bufsize", `${entry.videoBitrateK * 2}k`,
    "-c:a", "aac",
    "-b:a", `${entry.audioBitrateK}k`,
    // HLS + AES-128（方案A）
    "-hls_time", String(opts.hlsTimeSec ?? 6),
    "-hls_playlist_type", "vod",
    "-hls_segment_filename", `${outDir}/seg-%05d.ts`,
    "-hls_key_info_file", keyInfoPath,
    `${outDir}/index.m3u8`,
  ];
}

/** 主清单模板（Worker 生成；分发端改写后输出，ADR-0006 §3） */
export function buildMasterPlaylist(entries: LadderEntry[], opts: { mediaId: string }): string {
  const lines = ["#EXTM3U", "#EXT-X-VERSION:3"];
  for (const e of entries) {
    lines.push(`#EXT-X-STREAM-INF:BANDWIDTH=${(e.videoBitrateK + e.audioBitrateK) * 1000},RESOLUTION=${e.width}x${e.height},NAME="${e.name}"`);
    lines.push(`${e.name}/index.m3u8`);
  }
  return lines.join("\n") + "\n";
}

// 模板 → argv 编译器（ADR-0014；compileTemplate / compileKeepOriginal / validateTemplateParams）。
// 水印滤镜链编译器（spec.md §10.4 / ADR-0018）。
// 必须在此 re-export：包的 exports 只暴露 "."，不 re-export 则消费者（Worker / 管理端）无法引用。
export * from "./template";
export * from "./watermark";
