// 水印烧录端到端测试（真 ffmpeg，spec.md §10.4 / ADR-0018）
//
// 纯函数单测只能锁住「argv 长什么样」，锁不住「ffmpeg 是否真按预期成像」。这里用真 ffmpeg 跑
// 编译出的 argv 并逐像素比对「同模板无水印」产物，验证：
//   ① 定位与尺寸换算真的落到像素（变化像素包围盒 == 期望矩形）；
//   ② 水印区域外画面不受影响（无 alpha 泄漏 / 无黑底污染）；
//   ③ 移出画面、opacity=0 时画面完全不变。
// 缺 ffmpeg 时整组跳过（与 Worker 启动自检口径一致）。字体用本机 DejaVu 代替镜像内置的 Noto CJK
// （fontDir 可注入；只影响字形，不影响定位与尺寸换算的断言）。
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compileTemplate } from "../src/template";
import type { WatermarkSnapshotValue } from "../src/watermark";

const FFMPEG = Bun.which("ffmpeg");
const FONT_DIR = "/usr/share/fonts/truetype/dejavu";
const FONT_FILE = `${FONT_DIR}/DejaVuSans.ttf`;
const W = 640;
const H = 360;

const TPL = {
  codec: "libx264",
  bitrate_kbps: 6000,
  audio_bitrate_kbps: 64,
  resolutions: [{ mode: "fixed", width: W, height: H }],
};
const SOURCE = { width: 1280, height: 720, fps: 10, bitrateBps: 8_000_000 };

function run(args: string[]): void {
  const p = Bun.spawnSync(args, { captureStderr: true });
  if (p.exitCode !== 0) {
    throw new Error(`命令失败：${args[0]} :: ${new TextDecoder().decode(p.stderr).slice(-400)}`);
  }
}

function imageWatermark(over: Record<string, unknown> = {}): WatermarkSnapshotValue {
  return {
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
      size: { mode: "pixels", width: 100, height: 50 },
      ...over,
    },
    image_key: "watermark/x.png",
    image_ext: "png",
    image_width: 100,
    image_height: 50,
  } as unknown as WatermarkSnapshotValue;
}

function textWatermark(over: Record<string, unknown> = {}): WatermarkSnapshotValue {
  return {
    id: "cwmktext0000000000000002",
    name: "文字水印",
    type: "text",
    params: {
      type: "text",
      anchor: "bottom_right",
      offset_x: -20,
      offset_y: -20,
      opacity: 100,
      blend: "normal",
      text: "OpenVOD",
      font: "sans",
      color: "#ffffff",
      shadow: null,
      size: { mode: "pixels", size: 36 },
      ...over,
    },
  } as unknown as WatermarkSnapshotValue;
}

type Ctx = { dir: string; wmImage: string; baseline: Uint8Array };

/** 编译并执行一个计划，返回首个分片路径（wm=null 即「同模板无水印」基准） */
function encode(dir: string, wm: WatermarkSnapshotValue | null, wmImage?: string): string {
  const outRoot = join(dir, wm ? "out-wm" : "out-base");
  const plan = compileTemplate(TPL, SOURCE, {
    input: join(dir, "src.mp4"),
    outRoot,
    hlsTimeSec: 1,
    ...(wm
      ? { watermark: { snapshot: wm, imageUrl: wmImage ?? join(dir, "wm.png"), fontDir: FONT_DIR } }
      : {}),
  })[0];
  if (plan.skipped) throw new Error("档位被跳过，基准不成立");
  const outDir = join(outRoot, plan.name);
  mkdirSync(outDir, { recursive: true });
  run([FFMPEG!, ...plan.argv!]);
  return join(outDir, "seg-00000.ts");
}

function firstFrame(input: string): Uint8Array {
  const raw = `${input}.rgb`;
  run([
    FFMPEG!, "-hide_banner", "-loglevel", "error", "-y", "-i", input,
    "-frames:v", "1", "-pix_fmt", "rgb24", "-f", "rawvideo", raw,
  ]);
  const buf = new Uint8Array(readFileSync(raw));
  rmSync(raw, { force: true });
  return buf;
}

const at = (buf: Uint8Array, x: number, y: number) => {
  const i = (y * W + x) * 3;
  return [buf[i], buf[i + 1], buf[i + 2]];
};
const diff = (a: Uint8Array, b: Uint8Array, x: number, y: number) => {
  const p = at(a, x, y);
  const q = at(b, x, y);
  return Math.abs(p[0] - q[0]) + Math.abs(p[1] - q[1]) + Math.abs(p[2] - q[2]);
};

/** 变化像素（超阈值）的包围盒与数量；阈值按混合方式平缓程度调整 */
function changedBox(base: Uint8Array, got: Uint8Array, threshold: number) {
  let x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1, n = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (diff(base, got, x, y) > threshold) {
        n++;
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  return { n, box: n ? { x0, y0, x1, y1 } : null };
}

function setup(): Ctx {
  const dir = mkdtempSync(join(tmpdir(), "openvod-wm-ffmpeg-"));
  run([
    FFMPEG!, "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "testsrc=size=1280x720:rate=10:duration=1",
    "-pix_fmt", "yuv420p", join(dir, "src.mp4"),
  ]);
  const wmImage = join(dir, "wm.png");
  run([
    FFMPEG!, "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "color=c=red@1.0:s=100x50:d=1", "-frames:v", "1", wmImage,
  ]);
  return { dir, wmImage, baseline: firstFrame(encode(dir, null)) };
}

// 缺 ffmpeg 时整组跳过（与 Worker 启动自检口径一致）
if (FFMPEG) {
  describe("水印烧录端到端（真 ffmpeg）", () => {
    const ctx = setup();
    afterAll(() => rmSync(ctx.dir, { recursive: true, force: true }));

    test("基准可用：同模板无水印产物能正常产出单帧", () => {
      expect(ctx.baseline.length).toBe(W * H * 3);
    });

    test("图片 + 正常：变化像素包围盒 == 期望矩形（W−w+off, H−h+off）", () => {
      const got = firstFrame(encode(ctx.dir, imageWatermark()));
      const { n, box } = changedBox(ctx.baseline, got, 60);
      // 期望 x = 640−100−20 = 520，y = 360−50−20 = 290
      expect(n).toBeGreaterThan(1000);
      expect(box).toEqual({ x0: 520, y0: 290, x1: 619, y1: 339 });
    });

    test("图片 + 比例尺寸：宽度百分比换算 + 等比高度", () => {
      const got = firstFrame(encode(ctx.dir, imageWatermark({ size: { mode: "percent", width: 25 } })));
      const { box } = changedBox(ctx.baseline, got, 60);
      // 宽 640×25% = 160，等比高 160×(50/100) = 80；x = 640−160−20 = 460，y = 360−80−20 = 260
      expect(box).toEqual({ x0: 460, y0: 260, x1: 619, y1: 339 });
    });

    test("图片 + 移出画面：画面完全不变（ffmpeg 按坐标裁剪，不做额外限制）", () => {
      // 底右锚 + 正偏移 300 → x = 640−100+300 = 840，整块在画面右侧之外
      const right = firstFrame(encode(ctx.dir, imageWatermark({ offset_x: 300, offset_y: 0 })));
      expect(changedBox(ctx.baseline, right, 60).n).toBe(0);
      // 底左锚 + 负偏移 −300 → x = −300，整块在画面左侧之外
      const left = firstFrame(
        encode(ctx.dir, imageWatermark({ anchor: "bottom_left", offset_x: -300, offset_y: 0 })),
      );
      expect(changedBox(ctx.baseline, left, 60).n).toBe(0);
    });

    test("图片 + opacity=0：画面完全不变（不写出任何水印像素）", () => {
      const got = firstFrame(encode(ctx.dir, imageWatermark({ opacity: 0 })));
      expect(changedBox(ctx.baseline, got, 60).n).toBe(0);
    });

    test("图片 + 叠加混合：只在水印像素内生效（区域外无污染）", () => {
      const got = firstFrame(encode(ctx.dir, imageWatermark({ blend: "overlay" })));
      // Overlay 混合对中间调效果平缓，用较低阈值判定「确有变化」
      expect(changedBox(ctx.baseline, got, 20).n).toBeGreaterThan(0);
      let outside = 0;
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          const inBox = x >= 518 && x <= 621 && y >= 288 && y <= 341;
          if (!inBox && diff(ctx.baseline, got, x, y) > 90) outside++;
        }
      }
      expect(outside).toBe(0);
    });

    const withFont = existsSync(FONT_FILE);
    if (!withFont) {
      test.skip("本机无 DejaVu 字体：跳过文字水印端到端断言", () => {});
    }

    test("文字 + 正常：右下角出现文字像素且不越出画面边界", () => {
      if (!withFont) return;
      const got = firstFrame(encode(ctx.dir, textWatermark()));
      const { n, box } = changedBox(ctx.baseline, got, 60);
      expect(n).toBeGreaterThan(200);
      expect(box).not.toBeNull();
      // 锚点 bottom_right + 偏移 −20：右边界贴近 640−20，底边贴近 360−20
      expect(box!.x1).toBeGreaterThan(400);
      expect(box!.x1).toBeLessThanOrEqual(W - 18);
      expect(box!.y1).toBeLessThanOrEqual(H - 18);
      expect(box!.y1).toBeGreaterThan(H - 80);
    });

    test("文字 + opacity=0：画面完全不变", () => {
      if (!withFont) return;
      const got = firstFrame(encode(ctx.dir, textWatermark({ opacity: 0 })));
      expect(changedBox(ctx.baseline, got, 60).n).toBe(0);
    });
  });
} else {
  describe("水印烧录端到端（真 ffmpeg）", () => {
    test.skip("未安装 ffmpeg：整体跳过", () => {});
  });
}
