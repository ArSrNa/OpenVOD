// CEK 轮换编排核心（spec.md §4.4；ADR-0006 §6：CEK 轮换 = 重转码该媒资全部**加密**模板产物）
//
// 机制（与普通转码的关键差异）：
//   普通转码任务 `resolveMediaKey` 会**复用**已有密钥 → 重转码不换密钥；
//   轮换由管理端**预先生成一次**新密钥材料（createMediaKey，明文即时丢弃，只留 MK 封装形态），
//   把它固化进本批**全部**轮换任务的 `transcode_jobs.key_plan` —— Worker 以计划密钥转码并在
//   产物上传成功后整行替换 hls_keys。由此：
//   · 幂等：任何任务（含重启 / 乱序 / 分批完成）产出与落库的都是同一把新 CEK；
//   · 失败安全：全部任务完成前 hls_keys 不被触碰，旧产物照常可播（部分完成态 = 短时维护窗口）；
//   · 明文红线：key_plan 只含 MK 封装形态（与 hls_keys.wrapped_cek 同一信任域），明文 CEK 绝不落库。
//
// 本模块依赖注入（DB / 存储 / 模板查询全部经 deps），无 next/db 运行时依赖，纯单测可跑。
import {
  MediaKeyPlanSnapshot,
  RotateCekJob,
  RotateCekResponse,
  RotateCekSkipped,
  TranscodeTemplateDTO,
  WatermarkTemplateDTO,
  z,
} from "@openvod/contracts";
import type { MediaKeyMaterial } from "@openvod/crypto";
import type { MediaProduct } from "./media-products";
import { snapshotOf, type SubmitJobRow } from "./transcode-submit";

/** 业务错误（code 对齐 @openvod/shared ERROR_CODES） */
export class RotateCekError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** 待写入 transcode_jobs 的一行（模板快照 + 计划密钥） */
export interface RotateJobRow extends SubmitJobRow {
  /** 计划密钥（本批全部任务共用同一把；MK 封装形态，明文绝不入库） */
  keyPlan: z.infer<typeof MediaKeyPlanSnapshot>;
}

/** MediaKeyMaterial（含明文 CEK）→ 计划快照（丢弃明文，仅留封装形态；装配侧生成后明文即弃） */
export function keyPlanFromMaterial(m: MediaKeyMaterial): z.infer<typeof MediaKeyPlanSnapshot> {
  return {
    kid: m.kid,
    method: m.method,
    iv: m.ivHex,
    wrapped_cek: m.wrappedCekHex,
    mk_ver: m.mkVer,
  };
}

export interface RotateCekDeps {
  /** 校验媒资 ID 合法性（非法应抛带 code/status 的业务错误） */
  assertMediaId(mediaId: string): void;
  /** 取该媒资密钥行（无则 null —— 未加密过的媒资无需轮换） */
  findKeyRow(mediaId: string): Promise<{ kid: string } | null>;
  /** 查询该媒资未终结任务（含 keyPlan 有无，轮换进行中/普通转码中都要互斥） */
  listActiveJobs(mediaId: string): Promise<Array<{ id: string; templateId: string | null; keyPlan: unknown }>>;
  /** 该媒资有产物的模板集合（proceed/{id}/{templateId}/ 归组；空数组 = 无任何产物） */
  listProducts(mediaId: string): Promise<MediaProduct[]>;
  /** 取模板（**不存在返回 null** —— 孤儿产物降级为 skipped 而非整批失败） */
  findTemplate(templateId: string): Promise<z.infer<typeof TranscodeTemplateDTO> | null>;
  /** 取水印模板（模板已关联水印时调用；不存在应抛带 code/status 的业务错误） */
  getWatermark(id: string): Promise<z.infer<typeof WatermarkTemplateDTO>>;
  /** 批量创建任务（同一事务）；返回顺序须与入参一致 */
  createJobs(rows: RotateJobRow[]): Promise<Array<{ id: string }>>;
  /** 生成计划密钥快照（装配侧：createMediaKey(active MK) → keyPlanFromMaterial，明文即弃） */
  generateKeyPlan(): z.infer<typeof MediaKeyPlanSnapshot>;
}

/** 业务错误统一转换（deps 抛出的带 code/status 错误 → 本模块错误） */
function rethrowBusiness(e: unknown): never {
  const err = e as { code?: unknown; status?: unknown; message?: unknown };
  if (typeof err?.status === "number" && typeof err?.code === "string") {
    throw new RotateCekError(err.code, String(err.message ?? "请求校验失败"), err.status);
  }
  throw e;
}

/**
 * 发起 CEK 轮换：校验（媒资有密钥行 / 无进行中任务 / 有加密产物）→ 生成一次计划密钥 →
 * 每个有产物的**加密**模板各入队一条任务（共用同一把新 CEK）。模板缺失 / 未加密 / 旧布局的产物
 * 记入 skipped 供 UI 明示；一个都不可轮换时整批拒绝（400）。
 */
export async function rotateMediaKeyWithDeps(
  mediaId: string,
  deps: RotateCekDeps,
): Promise<z.infer<typeof RotateCekResponse>> {
  try {
    deps.assertMediaId(mediaId);
  } catch (e) {
    rethrowBusiness(e);
  }

  // 1) 必须已有密钥行：没有密钥 = 没有加密产物 = 无可轮换
  const keyRow = await deps.findKeyRow(mediaId);
  if (!keyRow) {
    throw new RotateCekError("not_found", `该媒资没有密钥（未加密或尚未转码），无需轮换：${mediaId}`, 404);
  }

  // 2) 媒资级互斥：存在任何未终结任务（普通转码或轮换）都拒绝。
  //    普通任务会复用旧 CEK 产出新密文，轮换落库后这些密文失效；轮换任务重复发起会生成第二把密钥。
  const running = await deps.listActiveJobs(mediaId);
  if (running.some((r) => r.keyPlan != null)) {
    throw new RotateCekError("bad_request", `媒资 ${mediaId} 正在进行 CEK 密钥轮换，请等待轮换任务完成`, 409);
  }
  if (running.length) {
    throw new RotateCekError(
      "bad_request",
      `媒资 ${mediaId} 有 ${running.length} 个进行中的转码任务，请等待完成后再发起轮换`,
      409,
    );
  }

  // 3) 找出有产物的模板（proceed/{id}/{templateId}/）；逐个判定能否入队
  const products = await deps.listProducts(mediaId);
  if (!products.length) {
    throw new RotateCekError(
      "bad_request",
      `媒资 ${mediaId} 没有转码产物（加密产物才承载密钥），无需轮换`,
      400,
    );
  }

  const jobs: z.infer<typeof RotateCekJob>[] = [];
  const skipped: z.infer<typeof RotateCekSkipped>[] = [];
  const pending: Array<{ template: z.infer<typeof TranscodeTemplateDTO>; watermark: z.infer<typeof WatermarkTemplateDTO> | null }> = [];

  for (const product of products) {
    // 旧布局产物（proceed/{id}/ 顶层，无模板段）：没有模板无法快照重转
    if (!product.templateId) {
      skipped.push({
        template_id: null,
        template_name: product.templateName ?? null,
        reason: "旧布局产物无模板关联，无法快照重转码；如需清理请在媒资产物列表删除",
      });
      continue;
    }
    const template = await deps.findTemplate(product.templateId);
    if (!template) {
      skipped.push({
        template_id: product.templateId,
        template_name: null,
        reason: "模板已删除，无法重转码；该产物在新密钥下不可播放，可在媒资产物列表删除",
      });
      continue;
    }
    if (!template.encrypt) {
      skipped.push({
        template_id: template.id,
        template_name: template.name,
        reason: "该模板未加密，产物不含 CEK，无需轮换",
      });
      continue;
    }
    if (template.format !== "HLS") {
      throw new RotateCekError(
        "bad_request",
        `模板「${template.name}」选择加密但输出格式非 HLS（模板数据异常，请在模板管理中修正）`,
        400,
      );
    }
    // 水印两层校验之发起侧（spec.md §10.4）：与普通转码同规则
    let watermark: z.infer<typeof WatermarkTemplateDTO> | null = null;
    if (template.watermark_id) {
      if (template.keep_original) {
        throw new RotateCekError(
          "bad_request",
          `模板「${template.name}」为「保持原视频配置」，不重编码无法烧录水印（模板数据异常，请在模板管理中修正）`,
          400,
        );
      }
      const wm = await deps.getWatermark(template.watermark_id).catch(rethrowBusiness);
      if (wm.type === "image" && !wm.image_key) {
        throw new RotateCekError(
          "bad_request",
          `模板「${template.name}」关联的水印「${wm.name}」尚未上传图片，请先上传或解除关联`,
          400,
        );
      }
      watermark = wm;
    }
    pending.push({ template, watermark });
    jobs.push({
      job_id: "",
      template_id: template.id,
      template_name: template.name,
      status: "QUEUED",
    });
  }

  if (!pending.length) {
    const detail = skipped.map((s) => s.reason).join("；");
    throw new RotateCekError("bad_request", `媒资 ${mediaId} 没有可轮换的加密产物：${detail}`, 400);
  }

  // 4) 生成**一次**计划密钥，固化进全部轮换任务（明文 CEK 在装配侧生成后即弃，不进本函数返回值）
  const keyPlan = deps.generateKeyPlan();

  // 5) 整批同一事务入队（模板快照结构与普通转码完全一致，Worker 只吃快照）
  const created = await deps.createJobs(
    pending.map((p) => ({
      mediaId,
      status: "QUEUED" as const,
      templateId: p.template.id,
      templateSnapshot: snapshotOf(p.template, p.watermark),
      keyPlan,
    })),
  );
  return {
    media_id: mediaId,
    kid: keyPlan.kid,
    jobs: jobs.map((j, i) => ({ ...j, job_id: created[i].id })),
    skipped,
  };
}
