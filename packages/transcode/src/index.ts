// ffmpeg / ffprobe 封装（ADR-0008）：argv 数组模板，永不经 shell 拼接（防注入）
// 密钥文件路径仅 Worker 注入；执行带超时；fMP4/CENC 演进时在此追加 Shaka Packager 调用。
import { execFile } from "node:child_process";
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

export async function runFFmpeg(argv: string[], timeoutMs = 6 * 3600_000): Promise<void> {
  try {
    await execFileP("ffmpeg", argv, { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 });
  } catch (e) {
    throw new FFmpegError(argv, (e as { stderr?: string }).stderr ?? String(e));
  }
}

export interface ProbeResult {
  format: {
    duration?: string;
    bit_rate?: string;
  };
  streams: Array<{
    codec_type?: string;
    codec_name?: string;
    width?: number;
    height?: number;
  }>;
}

export async function ffprobeJSON(input: string): Promise<ProbeResult> {
  const { stdout } = await execFileP(
    "ffprobe",
    ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", input],
    { timeout: 120_000, maxBuffer: 32 * 1024 * 1024 },
  );
  return JSON.parse(stdout);
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
 *   3) 显式 IV（hex，0x 前缀）
 */
export function buildKeyInfoFile(opts: {
  keyUriPlaceholder: string;
  cekFilePath: string;
  ivHex: string;
}): string {
  const iv = opts.ivHex.toLowerCase().replace(/^0x/, "");
  return `${opts.keyUriPlaceholder}\n${opts.cekFilePath}\n0x${iv}\n`;
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
