// 模板 → ffmpeg argv 编译器单测（intent.md「转码模板管理」规则 1/2；ADR-0014）
import { describe, expect, test } from "bun:test";
import { compileKeepOriginal, compileTemplate, TemplateCompileError } from "../src/template";

const OPTS = { input: "/tmp/in.mp4", outRoot: "/tmp/out" };

function params(overrides: Record<string, unknown> = {}) {
  return {
    codec: "libx264",
    bitrate_kbps: 5000,
    audio_bitrate_kbps: 128,
    resolutions: [{ mode: "fixed", width: 1920, height: 1080 }],
    ...overrides,
  };
}

const executed = (r: ReturnType<typeof compileTemplate>) => r.filter((v) => !v.skipped);
const skipped = (r: ReturnType<typeof compileTemplate>) => r.filter((v) => v.skipped);

describe("规则 1：只降不升", () => {
  test("源 1920x1080 → 目标 3840x2160：升格跳过", () => {
    const plans = compileTemplate(
      params({ resolutions: [{ mode: "fixed", width: 3840, height: 2160 }] }),
      { width: 1920, height: 1080, fps: 60 },
      OPTS,
    );
    expect(plans).toHaveLength(1);
    expect(plans[0].skipped).toBe(true);
    expect(plans[0].skipReason).toContain("升格");
  });

  test("源与目标完全相同（3840x2160 → 3840x2160）：跳过", () => {
    const plans = compileTemplate(
      params({ resolutions: [{ mode: "fixed", width: 3840, height: 2160 }] }),
      { width: 3840, height: 2160, fps: 60 },
      OPTS,
    );
    expect(skipped(plans)).toHaveLength(1);
    expect(plans[0].skipReason).toContain("相同");
  });

  test("源 1920x1080@60 → 目标 1920x1080@30：降帧率执行，argv 带 -r 30", () => {
    const plans = compileTemplate(
      params({ fps: 30, resolutions: [{ mode: "fixed", width: 1920, height: 1080 }] }),
      { width: 1920, height: 1080, fps: 60 },
      OPTS,
    );
    expect(executed(plans)).toHaveLength(1);
    const argv = plans[0].argv!;
    const ri = argv.indexOf("-r");
    expect(ri).toBeGreaterThan(-1);
    expect(argv[ri + 1]).toBe("30");
  });

  test("目标帧率高于源（帧率升格）：跳过", () => {
    const plans = compileTemplate(
      params({ fps: 60, resolutions: [{ mode: "fixed", width: 1280, height: 720 }] }),
      { width: 1920, height: 1080, fps: 30 },
      OPTS,
    );
    expect(skipped(plans)).toHaveLength(1);
    expect(plans[0].skipReason).toContain("帧率升格");
  });

  test("分辨率降级 + 帧率持平：执行且不写 -r", () => {
    const plans = compileTemplate(
      params({ fps: 30, resolutions: [{ mode: "fixed", width: 1280, height: 720 }] }),
      { width: 1920, height: 1080, fps: 30 },
      OPTS,
    );
    expect(executed(plans)).toHaveLength(1);
    expect(plans[0].argv).not.toContain("-r");
  });

  test("帧率降级维度 + 分辨率持平（1920x1080@60 → 1920x1080@30）：执行", () => {
    const plans = compileTemplate(
      params({ fps: 30, resolutions: [{ mode: "fixed", width: 1920, height: 1080 }] }),
      { width: 1920, height: 1080, fps: 60 },
      OPTS,
    );
    expect(executed(plans)).toHaveLength(1);
  });
});

describe("规则 2：自适应分辨率", () => {
  test("源 2160x1080 + 宽≤1920：等比缩放为 1920x960", () => {
    const plans = compileTemplate(
      params({ resolutions: [{ mode: "adaptive", max_width: 1920 }] }),
      { width: 2160, height: 1080, fps: null },
      OPTS,
    );
    expect(executed(plans)).toHaveLength(1);
    expect(plans[0].width).toBe(1920);
    expect(plans[0].height).toBe(960);
    expect(plans[0].argv).toContain("scale=1920:960:force_original_aspect_ratio=decrease");
  });

  test("源已在约束内（1600x900 + 宽≤1920）：跳过（open-questions #18）", () => {
    const plans = compileTemplate(
      params({ resolutions: [{ mode: "adaptive", max_width: 1920 }] }),
      { width: 1600, height: 900, fps: null },
      OPTS,
    );
    expect(skipped(plans)).toHaveLength(1);
    expect(plans[0].skipReason).toContain("约束内");
  });

  test("多维约束取更严格者：3840x2160 + 宽≤1280 → 1280x720", () => {
    const plans = compileTemplate(
      params({ resolutions: [{ mode: "adaptive", max_width: 1280, max_height: 2160 }] }),
      { width: 3840, height: 2160, fps: null },
      OPTS,
    );
    expect(plans[0].width).toBe(1280);
    expect(plans[0].height).toBe(720);
  });

  test("仅高度上限：2160x1080 + 高≤720 → 1440x720（宽高比不变）", () => {
    const plans = compileTemplate(
      params({ resolutions: [{ mode: "adaptive", max_height: 720 }] }),
      { width: 2160, height: 1080, fps: null },
      OPTS,
    );
    expect(plans[0].width).toBe(1440);
    expect(plans[0].height).toBe(720);
  });

  test("尺寸奇数偶数化（取偶）", () => {
    const plans = compileTemplate(
      params({ resolutions: [{ mode: "adaptive", max_width: 1919 }] }),
      { width: 2161, height: 1081, fps: null },
      OPTS,
    );
    expect(plans[0].width % 2).toBe(0);
    expect(plans[0].height % 2).toBe(0);
  });
});

describe("多档 ladder 与 argv 组装", () => {
  test("ladder 逐档独立判定：超规格档跳过、降级档执行", () => {
    const plans = compileTemplate(
      params({
        resolutions: [
          { mode: "fixed", width: 3840, height: 2160 },
          { mode: "fixed", width: 1920, height: 1080 },
          { mode: "fixed", width: 1280, height: 720 },
        ],
      }),
      { width: 1920, height: 1080, fps: null },
      OPTS,
    );
    // 2160p 升格跳过；1080p 与源全等（全维度持平）跳过；仅 720p 降级执行
    expect(skipped(plans)).toHaveLength(2);
    expect(executed(plans)).toHaveLength(1);
    expect(executed(plans).map((p) => p.name)).toEqual(["720p"]);
  });

  test("码率模式 argv：-b:v / -maxrate / -bufsize", () => {
    const argv = compileTemplate(params(), { width: 3840, height: 2160, fps: null }, OPTS)[0].argv!;
    expect(argv.join(" ")).toContain("-b:v 5000k");
    expect(argv.join(" ")).toContain("-maxrate 5350k");
    expect(argv.join(" ")).toContain("-bufsize 10000k");
    expect(argv).not.toContain("-crf");
  });

  test("CRF 模式 argv：-crf，无 -b:v", () => {
    const argv = compileTemplate(
      params({ crf: 23, bitrate_kbps: undefined }),
      { width: 3840, height: 2160, fps: null },
      OPTS,
    )[0].argv!;
    expect(argv.join(" ")).toContain("-crf 23");
    expect(argv).not.toContain("-b:v");
  });

  test("加密：keyInfoPath 注入 hls_key_info_file；不加密则无", () => {
    const enc = compileTemplate(params(), { width: 3840, height: 2160, fps: null }, {
      ...OPTS,
      keyInfoPath: "/tmp/jobs/1/keyinfo",
    })[0].argv!;
    expect(enc.join(" ")).toContain("-hls_key_info_file /tmp/jobs/1/keyinfo");
    const plain = compileTemplate(params(), { width: 3840, height: 2160, fps: null }, OPTS)[0].argv!;
    expect(plain).not.toContain("-hls_key_info_file");
  });

  test("x265 编码透传", () => {
    const argv = compileTemplate(
      params({ codec: "libx265" }),
      { width: 3840, height: 2160, fps: null },
      OPTS,
    )[0].argv!;
    expect(argv.join(" ")).toContain("-c:v libx265");
  });
});

describe("保持原视频（只加密流程）", () => {
  test("-c copy 重封装 + 可选加密，无重编码参数", () => {
    const argv = compileKeepOriginal({ input: "/tmp/in.mp4", outDir: "/tmp/out/orig" });
    expect(argv.join(" ")).toContain("-c copy");
    expect(argv.join(" ")).not.toContain("libx264");
    expect(argv).not.toContain("-hls_key_info_file");

    const enc = compileKeepOriginal({
      input: "/tmp/in.mp4",
      outDir: "/tmp/out/orig",
      keyInfoPath: "/tmp/jobs/1/keyinfo",
    });
    expect(enc.join(" ")).toContain("-hls_key_info_file /tmp/jobs/1/keyinfo");
  });
});

describe("非法参数防护", () => {
  test("脏快照（bitrate+crf 同时存在）抛 TemplateCompileError", () => {
    expect(() =>
      compileTemplate(
        { codec: "libx264", bitrate_kbps: 5000, crf: 23, resolutions: [{ mode: "fixed", width: 1280, height: 720 }] },
        { width: 3840, height: 2160, fps: null },
        OPTS,
      ),
    ).toThrow(TemplateCompileError);
  });

  test("脏快照（自适应无约束）抛 TemplateCompileError", () => {
    expect(() =>
      compileTemplate(
        { codec: "libx264", bitrate_kbps: 5000, resolutions: [{ mode: "adaptive" }] },
        { width: 3840, height: 2160, fps: null },
        OPTS,
      ),
    ).toThrow(TemplateCompileError);
  });
});
