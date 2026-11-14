// 字幕条目编辑的解析 / 拼回单测（spec.md §7.6）：
//   - 拆分：头行、cue 标识、时间轴设置、多行正文、NOTE/STYLE 块；
//   - 拼回：结果必须通过 §7.3 的服务端校验（validateVttText），且二次解析逐字等价；
//   - 时间戳：`HH:MM:SS.mmm` / `MM:SS.mmm` 双向转换；
//   - 保存前自检：空条目、结束不晚于开始、空正文、正文含空行全部拒绝。
import { describe, expect, it } from "bun:test";
import {
  parseVttDocument,
  serializeVttDocument,
  validateVttCues,
  type VttCue,
} from "../src/lib/vtt-cues";
import { VttError, formatVttTimestamp, parseVttTimestamp, validateVttText } from "../src/lib/vtt";

const SAMPLE = [
  "WEBVTT - 示例",
  "",
  "NOTE 这是注释",
  "注释可以多行",
  "",
  "1",
  "00:00:01.000 --> 00:00:03.500 align:middle",
  "第一句",
  "第二行",
  "",
  "00:00:04.000 --> 00:00:06.000",
  "第二句",
  "",
].join("\n");

function expectVttError(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(VttError);
    return (e as Error).message;
  }
  throw new Error("预期抛 VttError 但未抛出");
}

describe("parseVttDocument", () => {
  it("拆出头行、非 cue 块与条目（保留 cue 标识与时间轴设置）", () => {
    const doc = parseVttDocument(SAMPLE);
    expect(doc.header).toBe("WEBVTT - 示例");
    expect(doc.blocks).toEqual(["NOTE 这是注释\n注释可以多行"]);
    expect(doc.cues).toEqual([
      { id: "1", start: 1000, end: 3500, settings: "align:middle", text: "第一句\n第二行" },
      { start: 4000, end: 6000, text: "第二句" },
    ]);
  });

  it("容忍 BOM 与 CRLF", () => {
    const doc = parseVttDocument(`\uFEFF${SAMPLE.replace(/\n/g, "\r\n")}`);
    expect(doc.cues).toHaveLength(2);
    expect(doc.blocks).toHaveLength(1);
  });

  it("缺少 WEBVTT 头直接报错", () => {
    expect(expectVttError(() => parseVttDocument("00:00:01.000 --> 00:00:02.000\n你好"))).toContain(
      "WEBVTT",
    );
  });

  it("没有 cue 条目报错", () => {
    expect(expectVttError(() => parseVttDocument("WEBVTT\n\nNOTE 只有注释\n"))).toContain("cue");
  });

  it("时间轴非法 / 结束不晚于开始报错", () => {
    expect(
      expectVttError(() => parseVttDocument("WEBVTT\n\n00:00:01.00 --> 00:00:02.000\n你好")),
    ).toContain("时间轴格式非法");
    expect(
      expectVttError(() => parseVttDocument("WEBVTT\n\n00:00:03.000 --> 00:00:03.000\n你好")),
    ).toContain("必须晚于开始时间");
  });
});

describe("serializeVttDocument", () => {
  it("拼回文本通过服务端校验，且再解析与首次解析等价", () => {
    const doc = parseVttDocument(SAMPLE);
    const text = serializeVttDocument(doc);
    expect(() => validateVttText(text)).not.toThrow();
    expect(parseVttDocument(text)).toEqual(doc);
  });

  it("条目按给定顺序写出，正文多行原样保留", () => {
    const cues: VttCue[] = [
      { start: 0, end: 1500, text: "第一句" },
      { start: 2000, end: 3250, text: "第二句\n换行" },
    ];
    const text = serializeVttDocument({ header: "WEBVTT", blocks: [], cues });
    expect(text).toBe(
      "WEBVTT\n\n00:00:00.000 --> 00:00:01.500\n第一句\n\n00:00:02.000 --> 00:00:03.250\n第二句\n换行\n",
    );
    expect(parseVttDocument(text).cues).toEqual(cues);
  });
});

describe("时间戳", () => {
  it("解析与格式化互逆（含 MM:SS.mmm 写法）", () => {
    expect(parseVttTimestamp("01:02:03.004")).toBe(3_723_004);
    expect(parseVttTimestamp("02:03.004")).toBe(123_004);
    expect(formatVttTimestamp(3_723_004)).toBe("01:02:03.004");
    expect(formatVttTimestamp(123_004)).toBe("00:02:03.004");
    expect(formatVttTimestamp(-5)).toBe("00:00:00.000");
  });

  it("非法时间戳返回 null", () => {
    expect(parseVttTimestamp("00:61:00.000")).toBeNull();
    expect(parseVttTimestamp("1:2.3")).toBeNull();
    expect(parseVttTimestamp("")).toBeNull();
  });
});

describe("validateVttCues", () => {
  it("合法条目通过", () => {
    expect(() => validateVttCues([{ start: 0, end: 1000, text: "你好" }])).not.toThrow();
  });

  it("拒绝空列表 / 时间倒挂 / 空正文 / 正文含空行", () => {
    expect(expectVttError(() => validateVttCues([]))).toContain("至少保留一条");
    expect(expectVttError(() => validateVttCues([{ start: 2000, end: 1000, text: "a" }]))).toContain(
      "第 1 条",
    );
    expect(expectVttError(() => validateVttCues([{ start: 0, end: 1000, text: "  " }]))).toContain(
      "正文为空",
    );
    expect(
      expectVttError(() => validateVttCues([{ start: 0, end: 1000, text: "第一行\n\n第二行" }])),
    ).toContain("空行");
  });
});
