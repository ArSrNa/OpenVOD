// WebVTT 文档 ↔ 可编辑字幕条目（spec.md §7.6 字幕文本在线编辑）。
// 定位：把已有对象拆成「开始 / 结束 / 正文」条目供管理端逐条编辑，再把结果拼回合法 WebVTT；
// 写入前仍由服务端按 §7.3 二次校验，本模块不替代校验，只保证拆解与拼回不丢内容。
// 保真规则：NOTE / STYLE / REGION 等非 cue 块与 cue 标识行、时间轴行尾设置原样保留；
//   正文首尾空行去掉（空行按 WebVTT 语法会提前结束该条）。
import { VttError, formatVttTimestamp, parseVttTimestamp } from "./vtt";

/** 一条字幕 cue */
export interface VttCue {
  /** cue 标识行（WebVTT 可选；原样保留） */
  id?: string;
  /** 开始时间（毫秒） */
  start: number;
  /** 结束时间（毫秒，须严格大于 start） */
  end: number;
  /** 正文（多行以 `\n` 连接） */
  text: string;
  /** 时间轴行尾的 cue 设置（如 `align:middle`；原样保留） */
  settings?: string;
}

/** 拆分结果：头行 + 非 cue 块 + 条目 */
export interface VttDocument {
  /** 首个非空行（`WEBVTT` 或 `WEBVTT - 说明`） */
  header: string;
  /** 非 cue 块（NOTE / STYLE / REGION 与无法识别的块，原样保留） */
  blocks: string[];
  cues: VttCue[];
}

/** 非 cue 块的关键字（WebVTT 规范里不是字幕条目） */
const NON_CUE_BLOCK_RE = /^(NOTE|STYLE|REGION)(\s|$)/i;

/** 解析时间轴行；非法抛 VttError（消息直接展示给管理端用户） */
function parseTimingLine(line: string): { start: number; end: number; settings?: string } {
  const arrowAt = line.indexOf("-->");
  if (arrowAt < 0) throw new VttError(`时间轴行缺少 -->：${line.trim()}`);
  const left = line.slice(0, arrowAt).trim();
  const right = line.slice(arrowAt + 3).trim();
  const [endRaw = "", ...settingParts] = right.split(/\s+/);
  const start = parseVttTimestamp(left);
  const end = parseVttTimestamp(endRaw);
  if (start == null || end == null) throw new VttError(`时间轴格式非法：${line.trim()}`);
  if (end <= start) throw new VttError(`cue 结束时间必须晚于开始时间：${line.trim()}`);
  const settings = settingParts.join(" ").trim();
  return settings ? { start, end, settings } : { start, end };
}

/**
 * 拆分 WebVTT 文本（容错：BOM / CRLF / 前后空行）。
 * 无 `WEBVTT` 头或无 cue 条目 → 抛 VttError（这类对象本来就过不了 §7.3 校验）。
 */
export function parseVttDocument(input: string): VttDocument {
  const lines = input.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").split("\n");
  let index = 0;
  while (index < lines.length && lines[index].trim() === "") index += 1;
  const header = (lines[index] ?? "").trim();
  if (!/^WEBVTT(\s|$)/.test(header)) {
    throw new VttError("字幕文本缺少 WEBVTT 头，无法按条目编辑（可改用「替换内容」整文件替换）");
  }

  const doc: VttDocument = { header, blocks: [], cues: [] };
  let block: string[] = [];

  const flush = () => {
    if (!block.length) return;
    const current = block;
    block = [];
    if (NON_CUE_BLOCK_RE.test(current[0].trim())) {
      doc.blocks.push(current.join("\n"));
      return;
    }
    const timingAt = current.findIndex((line) => line.includes("-->"));
    if (timingAt < 0) {
      doc.blocks.push(current.join("\n"));
      return;
    }
    const id = timingAt > 0 ? current.slice(0, timingAt).join("\n").trim() : "";
    const body = current.slice(timingAt + 1);
    while (body.length && body[0].trim() === "") body.shift();
    while (body.length && body[body.length - 1].trim() === "") body.pop();
    const timing = parseTimingLine(current[timingAt]);
    doc.cues.push({ ...(id ? { id } : {}), ...timing, text: body.join("\n") });
  };

  for (index += 1; index < lines.length; index += 1) {
    if (lines[index].trim() === "") flush();
    else block.push(lines[index]);
  }
  flush();

  if (!doc.cues.length) throw new VttError("字幕文本里没有可编辑的 cue 条目");
  return doc;
}

/** 条目 → WebVTT 文本（头行、非 cue 块、cue 标识与设置原样带回） */
export function serializeVttDocument(doc: VttDocument): string {
  const parts: string[] = [doc.header.trim() || "WEBVTT"];
  for (const block of doc.blocks) {
    const trimmed = block.replace(/\s+$/, "");
    if (trimmed.trim()) parts.push(trimmed);
  }
  for (const cue of doc.cues) {
    const timing = `${formatVttTimestamp(cue.start)} --> ${formatVttTimestamp(cue.end)}${
      cue.settings ? ` ${cue.settings}` : ""
    }`;
    const head = cue.id ? `${cue.id}\n${timing}` : timing;
    parts.push(cue.text ? `${head}\n${cue.text}` : head);
  }
  return `${parts.join("\n\n")}\n`;
}

/** 保存前自检：条目数量与时间轴合法性（服务端仍会二次校验，§7.3） */
export function validateVttCues(cues: VttCue[]): void {
  if (!cues.length) throw new VttError("至少保留一条字幕条目");
  cues.forEach((cue, i) => {
    const n = i + 1;
    if (!Number.isFinite(cue.start) || !Number.isFinite(cue.end)) {
      throw new VttError(`第 ${n} 条时间非法`);
    }
    if (cue.start < 0) throw new VttError(`第 ${n} 条开始时间不能为负`);
    if (cue.end <= cue.start) throw new VttError(`第 ${n} 条结束时间必须晚于开始时间`);
    if (!cue.text.trim()) throw new VttError(`第 ${n} 条正文为空，请补上文本或删除该条`);
    if (/\n[ \t]*\n/.test(cue.text)) {
      throw new VttError(`第 ${n} 条正文不能包含空行（空行会提前结束该条字幕）`);
    }
  });
}
