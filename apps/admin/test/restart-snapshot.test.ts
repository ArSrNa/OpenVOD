// 重启任务「按当前模板重建快照」单测（2026-11-15 用户定；spec.md §5.1 / api.md §1.4）
// 覆盖：模板改动后重启用新参数、水印随模板更新、模板已删沿用旧快照、
// 新模板配置非法（keep_original + 水印 / 图片水印未传图）拒绝重启、CEK 轮换任务必须保持加密。
// 被测函数为依赖注入纯函数（./transcode-submit 的 rebuildSnapshotForRestart），不连 DB。
import { describe, expect, it } from "bun:test";
import { TranscodeSubmitError, rebuildSnapshotForRestart } from "../src/lib/transcode-submit";

const T = "cmu6tpla0001mqe4uoyceqt3";
const WM = "cwmktext0000000000000001";

type Template = Awaited<ReturnType<Parameters<typeof rebuildSnapshotForRestart>[1]["getTemplate"]>>;
type Watermark = Awaited<ReturnType<Parameters<typeof rebuildSnapshotForRestart>[1]["getWatermark"]>>;

function makeTemplate(over: Partial<{ name: string; keep_original: boolean; encrypt: boolean; watermark_id: string | null; bitrate: number }> = {}): Template {
  return {
    id: T,
    name: over.name ?? "原画加密",
    description: null,
    keep_original: over.keep_original ?? false,
    encrypt: over.encrypt ?? true,
    format: "HLS",
    params: {
      codec: "libx264",
      bitrate_kbps: over.bitrate ?? 4000,
      audio_bitrate_kbps: 128,
      resolutions: [{ mode: "fixed", width: 1920, height: 1080 }],
    },
    is_default: false,
    watermark_id: over.watermark_id ?? null,
    created_at: "2026-09-18T00:00:00.000Z",
    updated_at: "2026-09-18T00:00:00.000Z",
  };
}

function makeWatermark(over: Partial<{ name: string; text: string; uploaded: boolean }> = {}): Watermark {
  const uploaded = over.uploaded ?? true;
  return {
    id: WM,
    name: over.name ?? "台标",
    description: null,
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
    image_ext: uploaded ? "png" : null,
    image_key: uploaded ? `watermark/${WM}.png` : null,
    image_bytes: uploaded ? 2048 : null,
    image_width: uploaded ? 200 : null,
    image_height: uploaded ? 100 : null,
    image_status: uploaded ? "ready" : "missing",
    referenced_by: 1,
    created_at: "2026-10-02T00:00:00.000Z",
    updated_at: "2026-10-02T00:00:00.000Z",
  };
}

/** 业务错误（模拟 templates.ts / watermarks.ts 的 404） */
class BizError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

const OLD_SNAPSHOT = {
  template_id: T,
  name: "旧模板名",
  keep_original: false,
  encrypt: true,
  format: "HLS",
  params: { codec: "libx264", bitrate_kbps: 1000, audio_bitrate_kbps: 128, resolutions: [] },
  watermark: null,
};

function depsOf(template: Template | null, watermark: Watermark | null = null) {
  return {
    getTemplate: async (id: string): Promise<Template> => {
      if (!template) throw new BizError("not_found", `模板不存在：${id}`, 404);
      return template;
    },
    getWatermark: async (id: string): Promise<Watermark> => {
      if (!watermark) throw new BizError("not_found", `水印模板不存在：${id}`, 404);
      return watermark;
    },
  };
}

describe("重启重建快照", () => {
  it("模板改过参数 → 重启用新参数（不是入队时的旧快照）", async () => {
    const r = await rebuildSnapshotForRestart(
      { templateId: T, templateSnapshot: OLD_SNAPSHOT, keyPlan: null },
      depsOf(makeTemplate({ name: "原画加密", bitrate: 6000 })),
    );
    expect(r.refreshed).toBe(true);
    const snap = r.snapshot as typeof OLD_SNAPSHOT;
    expect(snap.name).toBe("原画加密");
    expect((snap.params as { bitrate_kbps: number }).bitrate_kbps).toBe(6000);
  });

  it("模板新关联水印 → 快照带新水印（图片元数据一并固化）", async () => {
    const r = await rebuildSnapshotForRestart(
      { templateId: T, templateSnapshot: OLD_SNAPSHOT, keyPlan: null },
      depsOf(makeTemplate({ watermark_id: WM }), makeWatermark()),
    );
    expect(r.refreshed).toBe(true);
    expect((r.snapshot as typeof OLD_SNAPSHOT).watermark).toMatchObject({
      id: WM,
      type: "image",
      image_key: `watermark/${WM}.png`,
    });
  });

  it("模板已删（templateId 为空）→ 沿用旧快照，不阻断重启", async () => {
    const r = await rebuildSnapshotForRestart(
      { templateId: null, templateSnapshot: OLD_SNAPSHOT, keyPlan: null },
      depsOf(null),
    );
    expect(r.refreshed).toBe(false);
    expect(r.snapshot).toBe(OLD_SNAPSHOT);
  });

  it("模板已删（templateId 还在但查询 404）→ 沿用旧快照", async () => {
    const r = await rebuildSnapshotForRestart(
      { templateId: T, templateSnapshot: OLD_SNAPSHOT, keyPlan: null },
      depsOf(null),
    );
    expect(r.refreshed).toBe(false);
    expect(r.snapshot).toBe(OLD_SNAPSHOT);
  });

  it("水印已删 → 同样沿用旧快照", async () => {
    const r = await rebuildSnapshotForRestart(
      { templateId: T, templateSnapshot: OLD_SNAPSHOT, keyPlan: null },
      depsOf(makeTemplate({ watermark_id: WM }), null),
    );
    expect(r.refreshed).toBe(false);
    expect(r.snapshot).toBe(OLD_SNAPSHOT);
  });

  it("模板被改成 keep_original + 水印 → 拒绝重启（配置非法）", async () => {
    await expect(
      rebuildSnapshotForRestart(
        { templateId: T, templateSnapshot: OLD_SNAPSHOT, keyPlan: null },
        depsOf(makeTemplate({ keep_original: true, watermark_id: WM }), makeWatermark()),
      ),
    ).rejects.toBeInstanceOf(TranscodeSubmitError);
  });

  it("模板关联的图片水印未传图 → 拒绝重启", async () => {
    await expect(
      rebuildSnapshotForRestart(
        { templateId: T, templateSnapshot: OLD_SNAPSHOT, keyPlan: null },
        depsOf(makeTemplate({ watermark_id: WM }), makeWatermark({ uploaded: false })),
      ),
    ).rejects.toBeInstanceOf(TranscodeSubmitError);
  });

  it("CEK 轮换任务被改成不加密 → 409 拒绝（key_plan 不会被消费）", async () => {
    const err = await rebuildSnapshotForRestart(
      { templateId: T, templateSnapshot: OLD_SNAPSHOT, keyPlan: { kid: "k" } },
      depsOf(makeTemplate({ encrypt: false })),
    ).catch((e: unknown) => e as TranscodeSubmitError);
    expect(err).toBeInstanceOf(TranscodeSubmitError);
    expect((err as TranscodeSubmitError).status).toBe(409);
  });

  it("CEK 轮换任务模板仍加密 → 正常刷新快照", async () => {
    const r = await rebuildSnapshotForRestart(
      { templateId: T, templateSnapshot: OLD_SNAPSHOT, keyPlan: { kid: "k" } },
      depsOf(makeTemplate({ encrypt: true })),
    );
    expect(r.refreshed).toBe(true);
    expect((r.snapshot as typeof OLD_SNAPSHOT).encrypt).toBe(true);
  });
});
