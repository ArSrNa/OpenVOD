// 模板 → ffmpeg argv 编译器单测（intent.md「转码模板管理」规则 1–4；ADR-0014）
// 判定维度 = 分辨率 / 帧率 / 码率：低于源的维度按模板降级；不低于源的维度取源值；
// 三维度均不低于源 → 跳过；全档跳过由 Worker 走 compileSourceMatched 兜底出片。
import { describe, expect, test } from "bun:test";
import { INPUT_RW_TIMEOUT_US } from "../src/ffmpeg-input";
import { buildKeyInfoFile } from "../src/index";
import {
  compileKeepOriginal,
  compileSourceMatched,
  compileTemplate,
  TemplateCompileError,
} from "../src/template";

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

  test("目标帧率高于源（帧率升格）：不补帧 → 分辨率降级时仍执行且 argv 不带 -r", () => {
    const plans = compileTemplate(
      params({ fps: 60, resolutions: [{ mode: "fixed", width: 1280, height: 720 }] }),
      { width: 1920, height: 1080, fps: 30 },
      OPTS,
    );
    expect(executed(plans)).toHaveLength(1);
    expect(plans[0].argv).not.toContain("-r");
    expect(plans[0].width).toBe(1280);
    expect(plans[0].height).toBe(720);
  });

  test("帧率升格且分辨率、码率均不低于源 → 三维度无降级：跳过", () => {
    const plans = compileTemplate(
      params({ fps: 60, resolutions: [{ mode: "fixed", width: 1920, height: 1080 }] }),
      { width: 1920, height: 1080, fps: 30, bitrateBps: 4_000_000 },
      OPTS,
    );
    expect(skipped(plans)).toHaveLength(1);
    expect(plans[0].skipReason).toContain("帧率升格");
    expect(plans[0].skipReason).toContain("无降级维度");
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

  test("码率降级（模板 3Mbps < 源 8Mbps）+ 分辨率持平：执行且分辨率/帧率取源值", () => {
    const plans = compileTemplate(
      params({ bitrate_kbps: 3000, resolutions: [{ mode: "fixed", width: 1920, height: 1080 }] }),
      { width: 1920, height: 1080, fps: 30, bitrateBps: 8_000_000 },
      OPTS,
    );
    expect(executed(plans)).toHaveLength(1);
    const argv = plans[0].argv!;
    expect(argv.join(" ")).toContain("-b:v 3000k");
    expect(argv).not.toContain("-vf"); // 分辨率不低于源 → 不缩放
    expect(argv).not.toContain("-r"); // 帧率不低于源 → 不补帧
    expect(plans[0].videoBitrateK).toBe(3000);
  });

  test("码率高于源：取源码率（不抬码率），分辨率降级仍执行", () => {
    const plans = compileTemplate(
      params({ bitrate_kbps: 12000, resolutions: [{ mode: "fixed", width: 1280, height: 720 }] }),
      { width: 1920, height: 1080, fps: 30, bitrateBps: 8_000_000 },
      OPTS,
    );
    expect(executed(plans)).toHaveLength(1);
    expect(plans[0].argv!.join(" ")).toContain("-b:v 8000k");
    expect(plans[0].videoBitrateK).toBe(8000);
  });

  test("自适应档源已在约束内 + 码率低于源：不再整档跳过，执行且分辨率取源", () => {
    const plans = compileTemplate(
      params({ bitrate_kbps: 2000, resolutions: [{ mode: "adaptive", max_width: 1920 }] }),
      { width: 1600, height: 900, fps: 30, bitrateBps: 6_000_000 },
      OPTS,
    );
    expect(executed(plans)).toHaveLength(1);
    expect(plans[0].width).toBe(1600);
    expect(plans[0].height).toBe(900);
    expect(plans[0].argv).not.toContain("-vf");
  });

  test("三维度全部不低于源（约束内 + 码率更高）：跳过，原因含三维度说明", () => {
    const plans = compileTemplate(
      params({ bitrate_kbps: 9000, resolutions: [{ mode: "adaptive", max_width: 1920 }] }),
      { width: 1600, height: 900, fps: 30, bitrateBps: 6_000_000 },
      OPTS,
    );
    expect(skipped(plans)).toHaveLength(1);
    expect(plans[0].skipReason).toContain("约束内");
    expect(plans[0].skipReason).toContain("码率不低于源");
    expect(plans[0].skipReason).toContain("无降级维度");
  });
});

describe("全档跳过兜底（compileSourceMatched）", () => {
  test("按模板产出单档：编码器/preset 按模板，分辨率/帧率/码率保持原视频", () => {
    const plan = compileSourceMatched(
      params({ codec: "libx265", preset: "fast", bitrate_kbps: 12000 }),
      { width: 1600, height: 900, fps: 30, bitrateBps: 6_000_000 },
      OPTS,
    );
    expect(plan.skipped).toBe(false);
    expect(plan.fallback).toBe(true);
    expect(plan.name).toBe("900p");
    expect(plan.width).toBe(1600);
    expect(plan.height).toBe(900);
    const argv = plan.argv!;
    expect(argv.join(" ")).toContain("-c:v libx265");
    expect(argv).not.toContain("-vf"); // 分辨率保持原视频
    expect(argv).not.toContain("-r"); // 帧率保持原视频
    expect(argv.join(" ")).toContain("-b:v 6000k"); // 码率取源（模板 12000k 高于源）
  });

  test("加密模板兜底同样注入 key_info", () => {
    const plan = compileSourceMatched(params(), { width: 1920, height: 1080, fps: 30 }, {
      ...OPTS,
      keyInfoPath: "/tmp/jobs/1/keyinfo",
    });
    expect(plan.argv!.join(" ")).toContain("-hls_key_info_file /tmp/jobs/1/keyinfo");
  });
});

describe("规则 4：自适应分辨率", () => {
  test("源 2160x1080 + 宽≤1920：等比缩放为 1920x960", () => {
    const plans = compileTemplate(
      params({ resolutions: [{ mode: "adaptive", max_width: 1920 }] }),
      { width: 2160, height: 1080, fps: null },
      OPTS,
    );
    expect(executed(plans)).toHaveLength(1);
    expect(plans[0].width).toBe(1920);
    expect(plans[0].height).toBe(960);
    expect(plans[0].argv).toContain("scale=1920:960:force_original_aspect_ratio=decrease:force_divisible_by=2");
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

  test("回归（2026-10-17）：源码宽高比与目标框不一致 → scale 强制偶数，防编码器拒开", () => {
    // force_original_aspect_ratio 会按源宽高比**重算**一维尺寸：2114×900 + box 1920×816
    // 在 ffmpeg 里实际算出 1917×816（宽奇数）→ libx265 报
    // "Picture width must be an integer multiple of the specified chroma subsampling"
    // 拒绝打开编码器（线上 9 个任务停摆的根因之一）。force_divisible_by=2 收敛为 1916×816。
    const plans = compileTemplate(
      params({ codec: "libx265", resolutions: [{ mode: "adaptive", max_width: 1920 }] }),
      { width: 2114, height: 900, fps: 30 },
      OPTS,
    );
    expect(executed(plans)).toHaveLength(1);
    expect(plans[0].width).toBe(1920);
    expect(plans[0].height).toBe(816);
    expect(plans[0].argv).toContain("scale=1920:816:force_original_aspect_ratio=decrease:force_divisible_by=2");
  });
});

// 保持原分辨率档（mode=source，2026-10-05 增）：分辨率维度恒取源值（不写 scale），
// 是否执行由帧率 / 码率维度判定；仍重编码，与 keep_original（-c copy）不是同一语义。
describe("保持原分辨率档（mode=source）", () => {
  test("码率降级：执行、不缩放、分辨率取源，变体名按源高度", () => {
    const plans = compileTemplate(
      params({ bitrate_kbps: 2000, resolutions: [{ mode: "source" }] }),
      { width: 1600, height: 900, fps: 30, bitrateBps: 6_000_000 },
      OPTS,
    );
    expect(executed(plans)).toHaveLength(1);
    expect(plans[0].name).toBe("900p");
    expect(plans[0].width).toBe(1600);
    expect(plans[0].height).toBe(900);
    expect(plans[0].argv).not.toContain("-vf");
    expect(plans[0].videoBitrateK).toBe(2000);
  });

  test("帧率降级：执行、写 -r、不缩放", () => {
    const plans = compileTemplate(
      params({ fps: 30, resolutions: [{ mode: "source" }] }),
      { width: 1920, height: 1080, fps: 60 },
      OPTS,
    );
    expect(executed(plans)).toHaveLength(1);
    const argv = plans[0].argv!;
    expect(argv[argv.indexOf("-r") + 1]).toBe("30");
    expect(argv).not.toContain("-vf");
    expect(plans[0].width).toBe(1920);
    expect(plans[0].height).toBe(1080);
  });

  test("三维度均不低于源：跳过，原因含「保持原分辨率」", () => {
    const plans = compileTemplate(
      params({ bitrate_kbps: 9000, resolutions: [{ mode: "source" }] }),
      { width: 1600, height: 900, fps: 30, bitrateBps: 6_000_000 },
      OPTS,
    );
    expect(skipped(plans)).toHaveLength(1);
    expect(plans[0].skipReason).toContain("保持原分辨率");
    expect(plans[0].skipReason).toContain("无降级维度");
  });

  test("ladder 混配：[保持原分辨率, 720p] 各自独立判定且目录名不冲突", () => {
    const plans = compileTemplate(
      params({
        bitrate_kbps: 3000,
        resolutions: [{ mode: "source" }, { mode: "fixed", width: 1280, height: 720 }],
      }),
      { width: 1920, height: 1080, fps: 30, bitrateBps: 8_000_000 },
      OPTS,
    );
    const exec = executed(plans);
    expect(exec.map((p) => p.name)).toEqual(["1080p", "720p"]);
    expect(exec[0].width).toBe(1920);
    expect(exec[0].height).toBe(1080);
    expect(exec[0].argv).not.toContain("-vf");
    expect(exec[1].argv).toContain("scale=1280:720:force_original_aspect_ratio=decrease:force_divisible_by=2");
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

// key_info 第三行必须**不带 0x**：ffmpeg 会自行加前缀，带上就产出 `IV=0x0x…` 并报
// `Error setting option encryption_iv`（加密失败、分片不产出）——实测 ffmpeg 6.1 踩坑回归守卫。
describe("key_info（ADR-0006 §2）", () => {
  const iv = "b1c09b64066a9ab1233f65f5d2efddc8";

  test("三行：占位 URI / CEK 路径 / 纯 hex IV", () => {
    expect(
      buildKeyInfoFile({
        keyUriPlaceholder: "https://delivery.example/v1/media/00000042/key",
        cekFilePath: "/tmp/jobs/j1/ceks/k.key",
        ivHex: iv,
      }),
    ).toBe(`https://delivery.example/v1/media/00000042/key\n/tmp/jobs/j1/ceks/k.key\n${iv}\n`);
  });

  test("调用方误传 0x / 大写也归一化为纯 hex", () => {
    const plain = "a".repeat(32);
    expect(buildKeyInfoFile({ keyUriPlaceholder: "u", cekFilePath: "p", ivHex: `0X${plain.toUpperCase()}` })).toBe(
      `u\np\n${plain}\n`,
    );
  });
});

// 水印接入 argv（spec.md §10.4 / ADR-0018）：编译入口层面的契约——有水印走 filter_complex，
// 无水印保持原 -vf 形态（不无谓改动既有 argv），水印随快照进每一档且跳过档不产片。
describe("水印接入 argv 编译（spec.md §10.4）", () => {
  const IMAGE_WM = {
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
      size: { mode: "percent", width: 20 },
    },
    image_key: "watermark/cwmkimg0000000000000001.png",
    image_ext: "png",
    image_width: 240,
    image_height: 120,
  };
  const opts = (watermark?: unknown) =>
    ({ ...OPTS, ...(watermark ? { watermark } : {}) }) as Parameters<typeof compileTemplate>[2];

  test("有水印：-vf 换成 -filter_complex + -map，图片型追加第二输入", () => {
    const plan = compileTemplate(
      params({ resolutions: [{ mode: "fixed", width: 1280, height: 720 }] }),
      { width: 1920, height: 1080, fps: 60 },
      opts({ snapshot: IMAGE_WM, imageUrl: "https://example.invalid/wm.png" }),
    )[0];
    const argv = plan.argv!;
    expect(argv).not.toContain("-vf");
    expect(argv[argv.indexOf("-filter_complex") + 1]).toContain("s=1280x720");
    expect(argv[argv.indexOf("-map") + 1]).toBe("[wmwm_out]");
    // 第二输入紧跟主输入之后（ffmpeg 要求 -i 在使用它的滤镜之前）
    const inputs = argv.reduce<number[]>((acc, a, i) => (a === "-i" ? [...acc, i] : acc), []);
    expect(inputs).toHaveLength(2);
    expect(argv[inputs[0] + 1]).toBe(OPTS.input);
    expect(argv[inputs[1] + 1]).toBe("https://example.invalid/wm.png");
  });

  test("无水印：argv 形态与既有实现完全一致（-vf，无 filter_complex）", () => {
    const argv = compileTemplate(
      params({ resolutions: [{ mode: "fixed", width: 1280, height: 720 }] }),
      { width: 1920, height: 1080, fps: 60 },
      OPTS,
    )[0].argv!;
    expect(argv).toContain("-vf");
    expect(argv).not.toContain("-filter_complex");
    expect(argv).not.toContain("-map");
  });

  test("水印逐档编译：各档按各自输出分辨率换算画布与尺寸", () => {
    const plans = executed(
      compileTemplate(
        params({
          resolutions: [
            { mode: "fixed", width: 1280, height: 720 },
            { mode: "fixed", width: 854, height: 480 },
          ],
        }),
        { width: 1920, height: 1080, fps: 60 },
        opts({ snapshot: IMAGE_WM, imageUrl: "https://example.invalid/wm.png" }),
      ),
    );
    expect(plans).toHaveLength(2);
    const fc = plans.map((p) => p.argv![p.argv!.indexOf("-filter_complex") + 1]);
    expect(fc[0]).toContain("s=1280x720");
    expect(fc[1]).toContain("s=854x480");
    // 20% 宽：1280 → 256（等比高 128）；854 → 171（等比高 86，854×0.2=170.8 取整 171）
    expect(fc[0]).toContain("scale=256:128");
    expect(fc[1]).toContain("scale=171:86");
  });

  test("水印路径必须显式带音频（-map 会使自动流选择失效，漏映射 → 无声视频，2026-10-05 踩坑）", () => {
    const plans = compileTemplate(
      params({ resolutions: [{ mode: "fixed", width: 1280, height: 720 }] }),
      { width: 1920, height: 1080, fps: 60 },
      opts({ snapshot: IMAGE_WM, imageUrl: "https://example.invalid/wm.png" }),
    );
    const argv = plans[0].argv!;
    // 视频（滤镜输出标签）+ 音频（0:a?）两条映射，缺一不可：出现任一 -map 后
    // ffmpeg 不再自动挑最佳音轨，只映射视频就会产出无声视频
    expect(argv[argv.indexOf("-map") + 1]).toBe("[wmwm_out]");
    expect(argv[argv.lastIndexOf("-map") + 1]).toBe("0:a?");
    expect(argv).toContain("-c:a");
    expect(argv).toContain("-b:a");
  });

  test("跳过的档位不产 argv（compileTemplate 只标跳过；兜底档由 Worker 的 buildPlans 追加）", () => {
    const plans = compileTemplate(
      params({ resolutions: [{ mode: "fixed", width: 1920, height: 1080 }] }),
      { width: 1920, height: 1080, fps: 30, bitrateBps: 1_000_000 },
      opts({ snapshot: IMAGE_WM, imageUrl: "https://example.invalid/wm.png" }),
    );
    expect(skipped(plans)).toHaveLength(1);
    expect(skipped(plans)[0].argv).toBeUndefined();
  });

  test("compileSourceMatched 兜底档同样带水印（转码侧模板不变体路径）", () => {
    const plan = compileSourceMatched(
      params(),
      { width: 1920, height: 1080, fps: 60 },
      opts({ snapshot: IMAGE_WM, imageUrl: "https://example.invalid/wm.png" }),
    );
    expect(plan.argv).toContain("-filter_complex");
    expect(plan.argv![plan.argv!.indexOf("-filter_complex") + 1]).toContain("colorchannelmixer");
  });

  test("文字水印不追加第二输入", () => {
    const plan = compileTemplate(
      params({ resolutions: [{ mode: "fixed", width: 1280, height: 720 }] }),
      { width: 1920, height: 1080, fps: 60 },
      opts({
        snapshot: {
          id: "cwmktext0000000000000002",
          name: "文字水印",
          type: "text",
          params: {
            type: "text",
            anchor: "center",
            offset_x: 0,
            offset_y: 0,
            opacity: 100,
            blend: "normal",
            text: "OpenVOD",
            font: "sans",
            color: "#ffffff",
            shadow: null,
            size: { mode: "percent", size: 5 },
          },
        },
      }),
    )[0];
    const argv = plan.argv!;
    expect(argv.filter((a) => a === "-i")).toHaveLength(1);
    expect(argv[argv.indexOf("-filter_complex") + 1]).toContain("drawtext=");
    // 文字比例字号按该档输出高度换算：720 × 5% = 36
    expect(argv[argv.indexOf("-filter_complex") + 1]).toContain("fontsize=36");
  });

  test("keep_original 路径不接受水印（-c copy 不解码，契约层已拒绝并存）", () => {
    const argv = compileKeepOriginal({ input: OPTS.input, outDir: "/tmp/out/1080p" });
    expect(argv).toContain("-c");
    expect(argv).not.toContain("-filter_complex");
  });
});

// 网络读超时（2026-10-17 回归）：源片与水印图都经预签名 URL 由 ffmpeg 网络拉取，
// CDN 停滞若无上限会把单任务悬挂到 6h 兜底超时——Worker 串行消费，一个挂死的任务
// 就堵住整个队列（实测一次 `-c copy` 被拖 10 分钟以上，9 个任务停摆）。
describe("网络读超时（-rw_timeout）", () => {
  const IMAGE_WM = {
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
      size: { mode: "percent", width: 20 },
    },
    image_key: "watermark/cwmkimg0000000000000001.png",
    image_ext: "png",
    image_width: 240,
    image_height: 120,
  };

  /** 每个 `-i` 之前两参必须恰为 `-rw_timeout <us>` */
  const allInputsGuarded = (argv: string[]) =>
    argv.every(
      (a, i) => a !== "-i" || (argv[i - 2] === "-rw_timeout" && argv[i - 1] === String(INPUT_RW_TIMEOUT_US)),
    );

  test("变体 argv：主输入前注入 rw_timeout", () => {
    const argv = compileTemplate(params(), { width: 3840, height: 2160, fps: null }, OPTS)[0].argv!;
    expect(argv.slice(0, 3)).toEqual(["-y", "-rw_timeout", String(INPUT_RW_TIMEOUT_US)]);
    expect(allInputsGuarded(argv)).toBe(true);
  });

  test("水印路径：主输入与图片第二输入都受保护", () => {
    const argv = compileTemplate(
      params({ resolutions: [{ mode: "fixed", width: 1280, height: 720 }] }),
      { width: 1920, height: 1080, fps: 60 },
      { ...OPTS, watermark: { snapshot: IMAGE_WM, imageUrl: "https://example.invalid/wm.png" } } as Parameters<
        typeof compileTemplate
      >[2],
    )[0].argv!;
    expect(argv.filter((a) => a === "-i")).toHaveLength(2);
    expect(allInputsGuarded(argv)).toBe(true);
  });

  test("keep_original（-c copy）：同样注入 rw_timeout", () => {
    const argv = compileKeepOriginal({ input: OPTS.input, outDir: "/tmp/out/orig" });
    expect(argv.slice(0, 3)).toEqual(["-y", "-rw_timeout", String(INPUT_RW_TIMEOUT_US)]);
    expect(allInputsGuarded(argv)).toBe(true);
  });

  test("compileSourceMatched 兜底档（含水印）同样受保护", () => {
    const plan = compileSourceMatched(
      params(),
      { width: 1920, height: 1080, fps: 60 },
      { ...OPTS, watermark: { snapshot: IMAGE_WM, imageUrl: "https://example.invalid/wm.png" } } as Parameters<
        typeof compileTemplate
      >[2],
    );
    expect(allInputsGuarded(plan.argv!)).toBe(true);
  });
});
