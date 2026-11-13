// CEK 轮换编排单测（spec.md §4.4；ADR-0006 §6）
// 覆盖：密钥行前置 404、媒资级互斥（轮换中 / 普通转码中 409）、无产物 400、
// 加密模板入队共用同一把计划密钥、模板已删 / 未加密 / 旧布局产物 skipped、全 skip 400、
// 计划密钥只含封装形态（明文不进任务行）与水印快照固化。
// 被测函数为依赖注入的纯编排（./keys-rotate），不连 DB / 不起模块 mock。
import { beforeEach, describe, expect, it } from "bun:test";
import { createMediaKey, parseMasterKeys, pickWrappingMasterKey } from "@openvod/crypto";
import {
  keyPlanFromMaterial,
  rotateMediaKeyWithDeps,
  type RotateCekDeps,
  type RotateJobRow,
} from "../src/lib/keys-rotate";
import type { MediaProduct } from "../src/lib/media-products";
import type { SubmitTranscodeDeps } from "../src/lib/transcode-submit";

const MEDIA_ID = "00000123";
const A = "cmu6tpla0001mqe4uoyceqt3";
const B = "cmu6tplb0002mqe4uoyceqt3";
const C = "cmu6tplc0003mqe4uoyceqt3";

const MKS = parseMasterKeys(`1:${"c".repeat(64)}`);

type Template = Awaited<ReturnType<SubmitTranscodeDeps["getTemplate"]>>;
type Watermark = Awaited<ReturnType<SubmitTranscodeDeps["getWatermark"]>>;

function makeTemplate(id: string, over: Partial<{ name: string; encrypt: boolean; watermark_id: string | null }> = {}): Template {
  return {
    id,
    name: over.name ?? `模板 ${id}`,
    description: null,
    keep_original: false,
    encrypt: over.encrypt ?? true,
    format: "HLS" as Template["format"],
    params: null,
    is_default: false,
    watermark_id: over.watermark_id ?? null,
    created_at: "2026-11-13T00:00:00.000Z",
    updated_at: "2026-11-13T00:00:00.000Z",
  };
}

function makeWatermark(id: string): Watermark {
  return {
    id,
    name: `水印 ${id}`,
    description: null,
    type: "text",
    params: {
      type: "text",
      anchor: "bottom_right",
      offset_x: -20,
      offset_y: -20,
      opacity: 80,
      blend: "normal",
      text: "OpenVOD",
      font: "sans",
      color: "#ffffff",
      shadow: null,
      size: { mode: "pixels", size: 32 },
    },
    image_ext: null,
    image_key: null,
    image_bytes: null,
    image_width: null,
    image_height: null,
    image_status: "ready",
    referenced_by: 0,
    created_at: "2026-11-13T00:00:00.000Z",
    updated_at: "2026-11-13T00:00:00.000Z",
  };
}

function product(templateId: string): MediaProduct {
  return { templateId, templateName: null, objects: 10, bytes: 1024, variants: ["720p"] };
}

/** 可变测试环境：用例按需覆写 */
interface Env {
  keyRow: { kid: string } | null;
  activeJobs: Array<{ id: string; templateId: string | null; keyPlan: unknown }>;
  products: MediaProduct[];
  templates: Map<string, Template>;
  watermarks: Map<string, Watermark>;
  created: RotateJobRow[];
}

function makeDeps(env: Env): RotateCekDeps {
  let seq = 0;
  return {
    assertMediaId: (id) => {
      if (!/^\d+$/.test(id)) {
        const e = new Error("媒资 ID 非法") as Error & { code: string; status: number };
        e.code = "bad_request";
        e.status = 400;
        throw e;
      }
      return id;
    },
    findKeyRow: async () => env.keyRow,
    listActiveJobs: async () => env.activeJobs,
    listProducts: async () => env.products,
    findTemplate: async (id) => env.templates.get(id) ?? null,
    getWatermark: async (id) => {
      const wm = env.watermarks.get(id);
      if (!wm) {
        const e = new Error(`水印不存在：${id}`) as Error & { code: string; status: number };
        e.code = "not_found";
        e.status = 404;
        throw e;
      }
      return wm;
    },
    createJobs: async (rows) => {
      env.created.push(...rows);
      return rows.map(() => ({ id: `job-${++seq}` }));
    },
    // 真实装配等价：createMediaKey → keyPlanFromMaterial（明文即弃）
    generateKeyPlan: () => keyPlanFromMaterial(createMediaKey(pickWrappingMasterKey(MKS))),
  };
}

function freshEnv(): Env {
  return {
    keyRow: { kid: "old-kid" },
    activeJobs: [],
    products: [],
    templates: new Map(),
    watermarks: new Map(),
    created: [],
  };
}

describe("rotateMediaKeyWithDeps（CEK 轮换编排）", () => {
  let env: Env;
  beforeEach(() => {
    env = freshEnv();
  });

  it("媒资没有密钥行 → 404（未加密过的媒资无需轮换）", async () => {
    env.keyRow = null;
    await expect(rotateMediaKeyWithDeps(MEDIA_ID, makeDeps(env))).rejects.toMatchObject({
      code: "not_found",
      status: 404,
    });
  });

  it("已有轮换任务进行中（keyPlan 非空）→ 409", async () => {
    env.activeJobs = [{ id: "j1", templateId: A, keyPlan: { kid: "x" } }];
    await expect(rotateMediaKeyWithDeps(MEDIA_ID, makeDeps(env))).rejects.toMatchObject({
      code: "bad_request",
      status: 409,
    });
  });

  it("已有普通转码任务进行中 → 409（轮换会换密钥，进行中产物将失效）", async () => {
    env.activeJobs = [{ id: "j1", templateId: A, keyPlan: null }];
    await expect(rotateMediaKeyWithDeps(MEDIA_ID, makeDeps(env))).rejects.toMatchObject({
      code: "bad_request",
      status: 409,
    });
  });

  it("无任何产物 → 400", async () => {
    await expect(rotateMediaKeyWithDeps(MEDIA_ID, makeDeps(env))).rejects.toMatchObject({
      code: "bad_request",
      status: 400,
    });
  });

  it("加密模板产物 → 每模板一条任务，全部共用同一把计划密钥", async () => {
    env.products = [product(A), product(B)];
    env.templates.set(A, makeTemplate(A));
    env.templates.set(B, makeTemplate(B));
    const r = await rotateMediaKeyWithDeps(MEDIA_ID, makeDeps(env));
    expect(r.jobs).toHaveLength(2);
    expect(r.jobs.map((j) => j.template_id)).toEqual([A, B]);
    expect(r.skipped).toEqual([]);
    expect(env.created).toHaveLength(2);
    // 关键不变量：本批全部任务共用同一把新 CEK（同一 kid / wrapped_cek / iv）
    expect(env.created[0].keyPlan).toEqual(env.created[1].keyPlan);
    expect(env.created[0].keyPlan.kid).toBe(r.kid);
    // 快照结构与普通转码一致（Worker 只吃快照）
    expect(env.created[0].templateSnapshot).toMatchObject({ template_id: A, encrypt: true, watermark: null });
    // 计划密钥是 MK 封装形态；明文 CEK 绝不进任务行（字段层面就不存在）
    expect(Object.keys(env.created[0].keyPlan).sort()).toEqual(["iv", "kid", "method", "mk_ver", "wrapped_cek"]);
  });

  it("混合产物：模板已删 / 未加密 / 旧布局 → skipped，仅加密模板入队", async () => {
    env.products = [product(A), product(B), product(C), product("")];
    env.templates.set(A, makeTemplate(A, { encrypt: true }));
    env.templates.set(B, makeTemplate(B, { encrypt: false, name: "不加密模板" }));
    // C 的模板已删除（templates 表无此行）
    const r = await rotateMediaKeyWithDeps(MEDIA_ID, makeDeps(env));
    expect(r.jobs.map((j) => j.template_id)).toEqual([A]);
    expect(r.skipped).toHaveLength(3);
    expect(r.skipped.map((s) => s.template_id)).toEqual([B, C, null]);
    expect(r.skipped.find((s) => s.template_id === B)?.reason).toContain("未加密");
    expect(r.skipped.find((s) => s.template_id === C)?.reason).toContain("已删除");
    expect(r.skipped.find((s) => s.template_id === null)?.reason).toContain("旧布局");
  });

  it("全部产物都不可轮换 → 400 并说明原因", async () => {
    env.products = [product(B)];
    env.templates.set(B, makeTemplate(B, { encrypt: false }));
    await expect(rotateMediaKeyWithDeps(MEDIA_ID, makeDeps(env))).rejects.toMatchObject({
      code: "bad_request",
      status: 400,
    });
  });

  it("加密模板关联水印 → 快照固化水印段（Worker 只吃快照）", async () => {
    const WM = "cwmktext0000000000000001";
    env.products = [product(A)];
    env.templates.set(A, makeTemplate(A, { watermark_id: WM }));
    env.watermarks.set(WM, makeWatermark(WM));
    const r = await rotateMediaKeyWithDeps(MEDIA_ID, makeDeps(env));
    expect(r.jobs).toHaveLength(1);
    expect(env.created[0].templateSnapshot).toMatchObject({ watermark: { id: WM, type: "text" } });
  });
});

describe("keyPlanFromMaterial", () => {
  it("封装材料逐字段对应，明文 CEK 不进快照", () => {
    const material = createMediaKey(pickWrappingMasterKey(MKS));
    const plan = keyPlanFromMaterial(material);
    expect(plan).toEqual({
      kid: material.kid,
      method: material.method,
      iv: material.ivHex,
      wrapped_cek: material.wrappedCekHex,
      mk_ver: material.mkVer,
    });
    expect(JSON.stringify(plan)).not.toContain(material.cek.toString("hex"));
  });
});
