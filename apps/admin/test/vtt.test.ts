// WebVTT 校验与语言标签归一化单测（spec.md §7.3；ADR-0009：只校验不重排）
// 覆盖：
//   - 语言归一化：下划线写法兼容、大小写规范化、script / region / variant 分段、非法标签拒绝；
//   - 展示名：trim、空值拒绝、长度上限；
//   - VTT 校验：合法文件归一化（BOM / CRLF / LF）、WEBVTT 头、cue 时间轴合法性（结束 > 开始）、
//     非 UTF-8 / 空文件 / 无 cue / 非法时间戳 / 超限全部拒绝，且**内容不重排**。
import { describe, expect, it } from "bun:test";
import { SUBTITLE_MAX_BYTES } from "@openvod/shared";
import {
  VttError,
  convertSrtToVtt,
  looksLikeSrt,
  normalizeSubtitleLabel,
  normalizeSubtitleLang,
  toVttText,
  validateVtt,
} from "../src/lib/vtt";

const enc = (s: string) => new TextEncoder().encode(s);

function expectVttError(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(VttError);
    return (e as Error).message;
  }
  throw new Error("预期抛 VttError 但未抛出");
}

// ---- 语言标签 ----

describe("normalizeSubtitleLang", () => {
  it("兼容下划线写法并归一化为 BCP-47 连字符形态", () => {
    expect(normalizeSubtitleLang("zh_CN")).toBe("zh-CN");
    expect(normalizeSubtitleLang("en_US")).toBe("en-US");
    expect(normalizeSubtitleLang("pt_br")).toBe("pt-BR");
  });

  it("大小写规范化：language 小写、script 首字母大写、region 大写、variant 小写", () => {
    expect(normalizeSubtitleLang("  ZH-hans-cn  ")).toBe("zh-Hans-CN");
    expect(normalizeSubtitleLang("zh_HANT_TW")).toBe("zh-Hant-TW");
    expect(normalizeSubtitleLang("fil")).toBe("fil");
  });

  it("非法标签拒绝（空 / 长度不符 / 含空格 / 纯数字）", () => {
    for (const bad of ["", "  ", "z", "1234", "zh CN", "zh_", "a1"]) {
      expectVttError(() => normalizeSubtitleLang(bad));
    }
  });
});

describe("normalizeSubtitleLabel", () => {
  it("trim 后返回；空与超长拒绝", () => {
    expect(normalizeSubtitleLabel("  简体中文  ")).toBe("简体中文");
    expectVttError(() => normalizeSubtitleLabel("   "));
    expectVttError(() => normalizeSubtitleLabel("x".repeat(65)));
  });
});

// ---- WebVTT 校验 ----

describe("validateVtt", () => {
  const ok = "WEBVTT\n\n00:00:01.000 --> 00:00:03.000\n你好\n";

  it("合法文件：去 BOM、CRLF → LF，正文不重排", () => {
    const raw = enc(`\uFEFFWEBVTT\r\n\r\n00:00:01.000 --> 00:00:03.000\r\n你好\r\n`);
    const text = validateVtt(raw);
    expect(text.startsWith("WEBVTT")).toBe(true);
    expect(text).not.toContain("\r");
    expect(text).toBe(ok);
  });

  it("允许 `WEBVTT - 说明` 头与 `MM:SS.mmm` 时间戳", () => {
    const text = validateVtt(enc("WEBVTT - 中文\n\n01:02.500 --> 01:05.000\nhi\n"));
    expect(text).toContain("01:02.500 --> 01:05.000");
  });

  it("cue 设置（align:middle 等）与 cue 编号不影响校验", () => {
    const text = validateVtt(
      enc("WEBVTT\n\n1\n00:00:01.000 --> 00:00:03.000 align:middle\n你好\n"),
    );
    expect(text).toContain("align:middle");
  });

  it("缺少 WEBVTT 头 → 拒绝", () => {
    expect(expectVttError(() => validateVtt(enc("00:00:01.000 --> 00:00:03.000\n你好\n")))).toContain(
      "WEBVTT",
    );
  });

  it("无 cue / 空文件 → 拒绝", () => {
    expect(expectVttError(() => validateVtt(enc("WEBVTT\n\n")))).toContain("cue");
    expect(expectVttError(() => validateVtt(enc("")))).toContain("空");
    expect(expectVttError(() => validateVtt(enc("   \n \n")))).toContain("空");
  });

  it("结束时间不晚于开始时间 → 拒绝", () => {
    expect(
      expectVttError(() => validateVtt(enc("WEBVTT\n\n00:00:03.000 --> 00:00:03.000\nx\n"))),
    ).toContain("结束时间");
    expect(
      expectVttError(() => validateVtt(enc("WEBVTT\n\n00:00:05.000 --> 00:00:03.000\nx\n"))),
    ).toContain("结束时间");
  });

  it("时间轴格式非法（缺毫秒 / 分钟越界）→ 拒绝", () => {
    expect(
      expectVttError(() => validateVtt(enc("WEBVTT\n\n00:00:01 --> 00:00:03\nx\n"))),
    ).toContain("时间轴");
    expect(
      expectVttError(() => validateVtt(enc("WEBVTT\n\n00:75:01.000 --> 00:80:03.000\nx\n"))),
    ).toContain("时间轴");
  });

  it("非法 UTF-8 字节序列 → 拒绝", () => {
    const bad = new Uint8Array([0x57, 0x45, 0x42, 0x56, 0x54, 0x54, 0xff, 0xfe]);
    expect(expectVttError(() => validateVtt(bad))).toContain("UTF-8");
  });

  it("超过上限（5 MiB）→ 拒绝", () => {
    const big = new Uint8Array(SUBTITLE_MAX_BYTES + 1);
    expect(expectVttError(() => validateVtt(big))).toContain("过大");
  });
});

// ---- SRT → VTT（spec.md §7.3：.srt 仅作输入格式，存储恒为 VTT） ----

describe("SRT 自动转换", () => {
  const SRT = "1\n00:00:01,000 --> 00:00:03,000\n你好\n\n2\n00:00:04,500 --> 00:00:06,000\n世界\n";

  it("looksLikeSrt：按时间轴区分 SRT / VTT", () => {
    expect(looksLikeSrt(SRT)).toBe(true);
    expect(looksLikeSrt("WEBVTT\n\n00:00:01.000 --> 00:00:03.000\nx\n")).toBe(false);
  });

  it("convertSrtToVtt：补 WEBVTT 头、逗号改点、保留序号行（cue 标识）", () => {
    const vtt = convertSrtToVtt(SRT);
    expect(vtt.startsWith("WEBVTT\n\n")).toBe(true);
    expect(vtt).toContain("00:00:01.000 --> 00:00:03.000");
    expect(vtt).toContain("00:00:04.500 --> 00:00:06.000");
    expect(vtt.split("\n")[2]).toBe("1"); // 序号行原样保留
  });

  it("补齐 1 位小时，并丢弃 SRT 专有定位参数（WebVTT 不支持）", () => {
    const vtt = convertSrtToVtt("1\n0:00:01,000 --> 00:00:03,000 X1:100 X2:200\nhi\n");
    expect(vtt.split("\n").find((l) => l.includes("-->"))).toBe("00:00:01.000 --> 00:00:03.000");
    expect(vtt).not.toContain("X1:100");
  });

  it("toVttText：SRT 字节流（BOM + CRLF）自动识别并转换为合法 VTT", () => {
    const text = toVttText(enc(`\uFEFF${SRT.replace(/\n/g, "\r\n")}`));
    expect(text.startsWith("WEBVTT")).toBe(true);
    expect(text).not.toContain("\r");
    expect(text).not.toContain(",000");
    expect(text).toContain("你好");
  });

  it("toVttText：VTT 输入原样通过（不重复加头）", () => {
    const vtt = "WEBVTT\n\n00:00:01.000 --> 00:00:03.000\nhi\n";
    expect(toVttText(enc(vtt))).toBe(vtt);
  });

  it("SRT 时间轴非法（结束早于开始）→ 转换后仍被校验拒绝", () => {
    expect(expectVttError(() => toVttText(enc("1\n00:00:05,000 --> 00:00:03,000\nx\n")))).toContain(
      "结束时间",
    );
  });

  it("既非 VTT 也非 SRT → 拒绝，且提示支持 .srt", () => {
    const msg = expectVttError(() => toVttText(enc("hello\nworld\n")));
    expect(msg).toContain("WEBVTT");
    expect(msg).toContain(".srt");
  });
});
