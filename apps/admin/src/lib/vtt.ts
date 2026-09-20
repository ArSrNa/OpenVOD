// WebVTT 校验、SRT→VTT 转换与语言标签归一化（spec.md §7.3；ADR-0009：只校验不重排）。
// 纯函数（不碰 DB / next / 存储），唯一使用方是管理端字幕上传与内容覆盖；
// 校验原因直接回显给管理端用户，故消息写成可读中文。
//
// 存储格式恒为 WebVTT（对象键 `…/{trackId}.vtt`）：`.srt` 仅作**输入**格式，
// 服务端自动转换后落库、落存储（不并存 SRT 对象、不保存 SRT 原文）。
import { SUBTITLE_LABEL_MAX, SUBTITLE_MAX_BYTES } from "@openvod/shared";

/** 字幕输入非法（由编排层转成 400 `bad_request`，spec.md §7.4） */
export class VttError extends Error {}

/** 字幕输入格式：v1 仅存 WebVTT（spec.md §7.3） */
export type SubtitleSourceFormat = "vtt" | "srt";

const MAX_MIB = SUBTITLE_MAX_BYTES / 1024 / 1024;

/** BCP-47 语言标签（可用子集，spec.md §7.1）：language(-script)?(-region)?(-variant)* */
const LANG_PATTERN = /^[a-z]{2,3}(-[a-z]{4})?(-[a-z]{2}|-[0-9]{3})?(-[a-z0-9]{5,8})*$/i;

/** SRT cue 时间轴行：`00:00:01,000 --> 00:00:03,000`（尾部 SRT 定位参数会被丢弃） */
const SRT_CUE_RE =
  /^(\d{1,2}):(\d{2}):(\d{2}),(\d{3})[ \t]*-->[ \t]*(\d{1,2}):(\d{2}):(\d{2}),(\d{3})(?:[ \t]+\S.*)?$/;

/**
 * 归一化语言标签（spec.md §7.1）：输入兼容下划线写法（`zh_CN` / `en_US`）与任意大小写，
 * 输出 BCP-47 连字符规范形态（language 小写、script 首字母大写、region 大写、variant 小写）。
 * 动机：`<track srclang>`、HLS `LANGUAGE`、iOS / Android 选轨 API 均以 BCP-47 为准。
 */
export function normalizeSubtitleLang(raw: string): string {
  const s = (raw ?? "").trim().replace(/_/g, "-").replace(/-{2,}/g, "-");
  if (!s) throw new VttError("语言标签不能为空（如 zh-CN / en-US）");
  if (!LANG_PATTERN.test(s)) {
    throw new VttError(`语言标签非法：${raw}（应为 BCP-47，如 zh-CN / en-US）`);
  }
  return s
    .split("-")
    .map((part, i) => {
      if (i === 0) return part.toLowerCase(); // language
      if (part.length === 4) return part[0].toUpperCase() + part.slice(1).toLowerCase(); // script
      if (part.length === 2 || /^\d{3}$/.test(part)) return part.toUpperCase(); // region
      return part.toLowerCase(); // variant
    })
    .join("-");
}

/** 展示名校验与归一化（spec.md §7.1：1–64 字符） */
export function normalizeSubtitleLabel(raw: string): string {
  const label = (raw ?? "").trim();
  if (!label) throw new VttError("展示名不能为空");
  if (label.length > SUBTITLE_LABEL_MAX) {
    throw new VttError(`展示名过长（≤${SUBTITLE_LABEL_MAX} 字符）`);
  }
  return label;
}

// ---- 解码 / 校验 ----

/**
 * 解码为 UTF-8 文本（spec.md §7.3）：非法序列拒绝、允许并剥离 BOM、换行统一为 LF。
 */
function decodeText(input: Uint8Array): string {
  if (!input.length) throw new VttError("字幕文件为空");
  if (input.length > SUBTITLE_MAX_BYTES) {
    throw new VttError(`字幕文件过大（上限 ${MAX_MIB} MiB）`);
  }
  let text: string;
  try {
    // fatal: true —— 非法 UTF-8 字节序列直接抛错（spec.md §7.3 第 2 条）
    text = new TextDecoder("utf-8", { fatal: true }).decode(input);
  } catch {
    throw new VttError("字幕文件不是合法 UTF-8 编码");
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); // 允许并剥离 BOM
  return text.replace(/\r\n?/g, "\n"); // 换行统一为 LF
}

/** `HH:MM:SS.mmm` / `MM:SS.mmm` → 毫秒；非法返回 null */
function parseTimestamp(raw: string): number | null {
  const m = /^(?:(\d{2,}):)?(\d{2}):(\d{2})\.(\d{3})$/.exec(raw.trim());
  if (!m) return null;
  const hours = Number(m[1] ?? 0);
  const minutes = Number(m[2]);
  const seconds = Number(m[3]);
  const millis = Number(m[4]);
  if (minutes > 59 || seconds > 59) return null;
  return ((hours * 60 + minutes) * 60 + seconds) * 1000 + millis;
}

/**
 * 校验 WebVTT 文本（spec.md §7.3）并原样返回。
 * 只校验与换行归一化，**不重排、不重编号、不改时间轴**（ADR-0009）。
 */
export function validateVttText(text: string): string {
  const lines = text.split("\n");
  const headIndex = lines.findIndex((l) => l.trim() !== "");
  if (headIndex < 0) throw new VttError("字幕文件为空");
  if (!/^WEBVTT(\s|$)/.test(lines[headIndex].trim())) {
    throw new VttError(
      "缺少 WEBVTT 头（可直接上传 .vtt，或上传 .srt 由服务端自动转换；" +
        "SRT 时间轴形如 00:00:01,000 --> 00:00:03,000）",
    );
  }

  let cues = 0;
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line.includes("-->")) continue;
    const [left, right] = line.split("-->");
    // 结束时间后可跟 cue 设置（align:middle 等），只取第一段
    const start = parseTimestamp(left ?? "");
    const end = parseTimestamp((right ?? "").trim().split(/\s+/)[0] ?? "");
    if (start == null || end == null) throw new VttError(`时间轴格式非法：${line}`);
    if (end <= start) throw new VttError(`cue 结束时间必须晚于开始时间：${line}`);
    cues += 1;
  }
  if (!cues) throw new VttError("至少需要一条字幕 cue（形如 00:00:01.000 --> 00:00:03.000）");
  return text;
}

/** 校验 WebVTT 字节流（spec.md §7.3）：解码 + 校验，返回可存储文本（UTF-8 / LF / 无 BOM） */
export function validateVtt(input: Uint8Array): string {
  return validateVttText(decodeText(input));
}

// ---- SRT → VTT（spec.md §7.3） ----

/** 该文本是否含 SRT 时间轴（用于与 VTT 区分；无 `WEBVTT` 头时才需要判断） */
export function looksLikeSrt(text: string): boolean {
  return text.split("\n").some((line) => SRT_CUE_RE.test(line.trim()));
}

/** `HH:MM:SS,mmm` → `HH:MM:SS.mmm`（小时补齐两位） */
function srtTimestamp(h: string, mm: string, ss: string, ms: string): string {
  return `${h.padStart(2, "0")}:${mm}:${ss}.${ms}`;
}

/**
 * SRT → WebVTT（spec.md §7.3）：
 *   - 时间轴逗号改点（`00:00:01,000 --> 00:00:03,000` → `00:00:01.000 --> 00:00:03.000`）；
 *   - 前置 `WEBVTT` 头；序号行原样保留（WebVTT 允许 cue 标识行）；
 *   - 丢弃 SRT 专有的定位参数（时间轴行尾的 `X1:… / Y1:…` 等，WebVTT 不支持）。
 */
export function convertSrtToVtt(text: string): string {
  const body = text
    .split("\n")
    .map((line) => {
      const m = SRT_CUE_RE.exec(line.trim());
      if (!m) return line;
      return `${srtTimestamp(m[1], m[2], m[3], m[4])} --> ${srtTimestamp(m[5], m[6], m[7], m[8])}`;
    })
    .join("\n")
    .replace(/^\n+/, "");
  return `WEBVTT\n\n${body}`;
}

/**
 * 上传字节流 → 可存储的 WebVTT 文本（spec.md §7.3）：
 * 自动识别 `.vtt`（以 `WEBVTT` 开头）与 `.srt`（含 SRT 时间轴则自动转换），随后统一校验。
 * 只校验与格式转换，不重排正文（ADR-0009）。
 */
export function toVttText(input: Uint8Array): string {
  const text = decodeText(input);
  const head = text.split("\n").find((l) => l.trim() !== "");
  const isVtt = head !== undefined && /^WEBVTT(\s|$)/.test(head.trim());
  const body = isVtt || !looksLikeSrt(text) ? text : convertSrtToVtt(text);
  const vtt = validateVttText(body);
  if (vtt.length > SUBTITLE_MAX_BYTES) {
    // 转换会略增体积（补 WEBVTT 头），存储前的最终上限仍按同一常量约束
    throw new VttError(`转换后字幕文件过大（上限 ${MAX_MIB} MiB）`);
  }
  return vtt;
}
