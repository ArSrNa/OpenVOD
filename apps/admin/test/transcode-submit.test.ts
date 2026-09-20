// 发起转码「多选模板」单测（spec.md §2.1/§5.1；ADR-0014）
// 覆盖：多选各入队一条任务、去重、同媒资同模板冲突 409、不同模板可并行、空选拒绝、加密必须 HLS、模板不存在。
// 被测函数为依赖注入的纯编排（./transcode-submit），不连 DB / 不起模块 mock。
import { beforeEach, describe, expect, it } from "bun:test";
import {
  submitTranscodeWithDeps,
  type SubmitJobRow,
  type SubmitTranscodeDeps,
} from "../src/lib/transcode-submit";

const MEDIA_ID = "00000123";
const A = "cmu6tpla0001mqe4uoyceqt3";
const B = "cmu6tplb0002mqe4uoyceqt3";
const C = "cmu6tplc0003mqe4uoyceqt3";

type Template = Awaited<ReturnType<SubmitTranscodeDeps["getTemplate"]>>;

function makeTemplate(
  id: string,
  over: Partial<{ name: string; keep_original: boolean; encrypt: boolean; format: string }> = {},
): Template {
  return {
    id,
    name: over.name ?? `模板 ${id}`,
    description: null,
    keep_original: over.keep_original ?? false,
    encrypt: over.encrypt ?? false,
    format: (over.format ?? "HLS") as Template["format"],
    params: {
      codec: "libx264",
      bitrate_kbps: 1000,
      audio_bitrate_kbps: 128,
      resolutions: [{ mode: "fixed", width: 1280, height: 720 }],
    },
    is_default: false,
    created_at: "2026-09-18T00:00:00.000Z",
    updated_at: "2026-09-18T00:00:00.000Z",
  };
}

/** 业务错误（模拟 templates.ts 的 TemplateError：带 code/status） */
class BizError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

const state = {
  jobs: [] as SubmitJobRow[],
  running: [] as Array<{ id: string; templateId: string | null }>,
  templates: new Map<string, Template>(),
};

function makeDeps(over: Partial<SubmitTranscodeDeps> = {}): SubmitTranscodeDeps {
  return {
    assertMediaId: (id) => id,
    findMedia: async (id) =>
      id === MEDIA_ID ? { id: MEDIA_ID, sourceKey: `original/${MEDIA_ID}.mp4` } : null,
    resolveOriginalKey: async () => `original/${MEDIA_ID}.mp4`,
    getTemplate: async (id) => {
      const t = state.templates.get(id);
      if (!t) throw new BizError("not_found", `模板不存在：${id}`, 404);
      return t;
    },
    listActiveJobs: async () => state.running,
    createJobs: async (rows) => {
      state.jobs.push(...rows);
      return rows.map((_, i) => ({ id: `job_${i + 1}` }));
    },
    ...over,
  };
}

beforeEach(() => {
  state.jobs = [];
  state.running = [];
  state.templates = new Map([
    [A, makeTemplate(A)],
    [B, makeTemplate(B, { name: "B 加密", encrypt: true })],
    [C, makeTemplate(C, { name: "C 只加密", keep_original: true })],
  ]);
});

describe("发起转码：多选转码模板", () => {
  it("多选：每个模板各入队一条任务，返回对应 job_id", async () => {
    const res = await submitTranscodeWithDeps(MEDIA_ID, { template_ids: [A, B, C] }, makeDeps());

    expect(res.jobs).toHaveLength(3);
    expect(state.jobs).toHaveLength(3);
    expect(state.jobs.map((j) => j.templateId)).toEqual([A, B, C]);
    expect(res.jobs.map((j) => j.job_id)).toEqual(state.jobs.map((_, i) => `job_${i + 1}`));
    expect(res.jobs[0]).toMatchObject({ template_id: A, status: "QUEUED" });
    // 每个模板各自快照（ADR-0014 防漂移）
    expect(state.jobs[1].templateSnapshot).toMatchObject({ template_id: B, encrypt: true });
    expect(state.jobs[2].templateSnapshot).toMatchObject({ template_id: C, keep_original: true });
  });

  it("去重：重复选择同一模板只入队一次", async () => {
    const res = await submitTranscodeWithDeps(MEDIA_ID, { template_ids: [A, A, B] }, makeDeps());
    expect(res.jobs.map((j) => j.template_id)).toEqual([A, B]);
    expect(state.jobs).toHaveLength(2);
  });

  it("同一媒资 + 同一模板已在跑 → 409，且整批不入队", async () => {
    state.running = [{ id: "job_running", templateId: A }];
    await expect(
      submitTranscodeWithDeps(MEDIA_ID, { template_ids: [A, B] }, makeDeps()),
    ).rejects.toMatchObject({ code: "bad_request", status: 409 });
    expect(state.jobs).toHaveLength(0);
  });

  it("同一媒资不同模板已在跑 → 允许并行（产物分树互不覆盖）", async () => {
    state.running = [{ id: "job_running", templateId: A }];
    const res = await submitTranscodeWithDeps(MEDIA_ID, { template_ids: [B, C] }, makeDeps());
    expect(res.jobs.map((j) => j.template_id)).toEqual([B, C]);
    expect(state.jobs).toHaveLength(2);
  });

  it("空数组拒绝：至少选择一个模板", async () => {
    await expect(
      submitTranscodeWithDeps(MEDIA_ID, { template_ids: [] }, makeDeps()),
    ).rejects.toMatchObject({ status: 400 });
    expect(state.jobs).toHaveLength(0);
  });

  it("加密 + 非 HLS 组合整批拒绝", async () => {
    state.templates.set(C, makeTemplate(C, { encrypt: true, format: "MP4" }));
    await expect(
      submitTranscodeWithDeps(MEDIA_ID, { template_ids: [A, C] }, makeDeps()),
    ).rejects.toMatchObject({ status: 400 });
    expect(state.jobs).toHaveLength(0);
  });

  it("模板不存在 → 404，整批拒绝", async () => {
    await expect(
      submitTranscodeWithDeps(MEDIA_ID, { template_ids: [A, "cnotexists"] }, makeDeps()),
    ).rejects.toMatchObject({ code: "not_found", status: 404 });
    expect(state.jobs).toHaveLength(0);
  });

  it("媒资不存在 → 404", async () => {
    await expect(
      submitTranscodeWithDeps("99999999", { template_ids: [A] }, makeDeps()),
    ).rejects.toMatchObject({ code: "not_found", status: 404 });
  });
});
