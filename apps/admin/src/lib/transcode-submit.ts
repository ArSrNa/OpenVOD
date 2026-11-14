// 发起转码的编排核心（**多选**模板，ADR-0014）：一次提交 → 每个模板各入队一条任务。
// 本模块只依赖 contracts（zod）：DB / 存储 / 模板查询全部经 deps 注入，
// 无 next/db/模板运行时依赖，便于纯单测（不起 mock、不连库）。
// 水印（spec.md §10.4）：模板保存侧已校验过一次，这里在**任务发起侧**再校验一次，
// 并把水印模板内容快照进 transcode_jobs.template_snapshot.watermark（Worker 只读快照）。
import {
  TranscodeSubmitRequest,
  TranscodeSubmitResponse,
  TranscodeTemplateDTO,
  WatermarkSnapshot,
  WatermarkTemplateDTO,
  z,
} from "@openvod/contracts";

/** 业务错误（code 对齐 @openvod/shared ERROR_CODES） */
export class TranscodeSubmitError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** 快照中的水印段（contracts WatermarkSnapshot：自包含，图片元数据一并固化） */
export type SnapshotWatermark = z.infer<typeof WatermarkSnapshot>;

/** 待写入 transcode_jobs 的一行（模板快照已就绪） */
export interface SubmitJobRow {
  mediaId: string;
  status: "QUEUED";
  templateId: string;
  templateSnapshot: {
    template_id: string;
    name: string;
    keep_original: boolean;
    encrypt: boolean;
    format: string;
    params: unknown;
    watermark: SnapshotWatermark | null;
  };
}

export interface SubmitTranscodeDeps {
  /** 校验媒资 ID 合法性（非法应抛带 code/status 的业务错误） */
  assertMediaId(mediaId: string): string;
  /** 取媒资（不存在返回 null） */
  findMedia(mediaId: string): Promise<{ id: string; sourceKey: string | null } | null>;
  /** 解析 original 键（DB 优先 / 存储兜底） */
  resolveOriginalKey(mediaId: string): Promise<string | null>;
  /** 取模板（不存在应抛带 code/status 的业务错误） */
  getTemplate(id: string): Promise<z.infer<typeof TranscodeTemplateDTO>>;
  /** 取水印模板（模板已关联水印时调用；不存在应抛带 code/status 的业务错误） */
  getWatermark(id: string): Promise<z.infer<typeof WatermarkTemplateDTO>>;
  /** 查询该媒资未终结任务（同模板冲突判定用）；`keyPlan` 非空 = 该任务是 CEK 轮换任务（spec.md §4.4） */
  listActiveJobs(mediaId: string): Promise<Array<{ id: string; templateId: string | null; keyPlan?: unknown }>>;
  /** 批量创建任务（同一事务）；返回顺序须与入参一致 */
  createJobs(rows: SubmitJobRow[]): Promise<Array<{ id: string }>>;
}

/** 水印模板 → 快照段（只取 Worker 编译必需的字段；类型即 contracts WatermarkSnapshot） */
function watermarkSnapshotOf(watermark: z.infer<typeof WatermarkTemplateDTO>): SnapshotWatermark {
  return {
    id: watermark.id,
    name: watermark.name,
    type: watermark.type,
    params: watermark.params,
    image_key: watermark.image_key,
    image_ext: watermark.image_ext,
    image_width: watermark.image_width,
    image_height: watermark.image_height,
  };
}

/** 模板快照（ADR-0014 防漂移）：Worker 只吃快照，模板后续改删不影响本任务。
 *  导出复用：CEK 轮换（lib/keys-rotate）的轮换任务快照结构与普通转码完全一致。 */
export function snapshotOf(
  template: z.infer<typeof TranscodeTemplateDTO>,
  watermark: SnapshotWatermark | null,
): SubmitJobRow["templateSnapshot"] {
  return {
    template_id: template.id,
    name: template.name,
    keep_original: template.keep_original,
    encrypt: template.encrypt,
    format: template.format,
    params: template.params,
    watermark,
  };
}

/**
 * 模板 → 任务快照（含水印的两层校验，spec.md §10.4）。
 * 发起与**重启**共用：重启按当前模板重建快照，改完模板再重启即生效（2026-11-15）。
 * 只把「模板自身配置非法」转成 TranscodeSubmitError；水印查询失败原样上抛，
 * 便于重启侧把「引用的水印已被删」与「配置写错」区分开。
 */
export async function snapshotForTemplate(
  template: z.infer<typeof TranscodeTemplateDTO>,
  getWatermark: (id: string) => Promise<z.infer<typeof WatermarkTemplateDTO>>,
): Promise<SubmitJobRow["templateSnapshot"]> {
  if (template.encrypt && template.format !== "HLS") {
    throw new TranscodeSubmitError("bad_request", `模板「${template.name}」选择了加密，输出格式必须为 HLS`, 400);
  }
  // 水印两层校验之一（任务发起侧）：模板可能被绕过管理端直接改库，故再拦一次
  if (template.watermark_id && template.keep_original) {
    throw new TranscodeSubmitError(
      "bad_request",
      `模板「${template.name}」为「保持原视频配置」，不重编码无法烧录水印`,
      400,
    );
  }
  if (!template.watermark_id) return snapshotOf(template, null);
  const watermark = await getWatermark(template.watermark_id);
  if (watermark.type === "image" && !watermark.image_key) {
    throw new TranscodeSubmitError(
      "bad_request",
      `模板「${template.name}」关联的水印「${watermark.name}」尚未上传图片，请先上传或解除关联`,
      400,
    );
  }
  return snapshotOf(template, watermarkSnapshotOf(watermark));
}

/** 把任意「带 code/status 的业务错误」转成本模块错误；否则原样抛出 */
function rethrowBusiness(e: unknown): never {
  const err = e as { code?: unknown; status?: unknown; message?: unknown };
  if (typeof err?.status === "number" && typeof err?.code === "string") {
    throw new TranscodeSubmitError(
      err.code,
      typeof err.message === "string" ? err.message : "请求校验失败",
      err.status,
    );
  }
  throw e;
}

/**
 * 发起转码（多选模板）：校验媒资 / 原始文件 / 每个模板 → 同媒资同模板防冲突 → 每模板各入队一条任务。
 * 不生成 argv（源参数未知，ADR-0014）；产物各落 `proceed/{mediaId}/{templateId}/`。
 */
export async function submitTranscodeWithDeps(
  mediaId: string,
  body: unknown,
  deps: SubmitTranscodeDeps,
): Promise<z.infer<typeof TranscodeSubmitResponse>> {
  try {
    deps.assertMediaId(mediaId);
  } catch (e) {
    rethrowBusiness(e);
  }

  const parsed = TranscodeSubmitRequest.safeParse(body);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new TranscodeSubmitError(
      "bad_request",
      `${issue?.path.join(".") ?? ""} ${issue?.message ?? "请求体校验失败"}`,
      400,
    );
  }
  // 去重并保持请求顺序（同一模板重复选择只入队一次）
  const templateIds = [...new Set(parsed.data.template_ids)];

  const media = await deps.findMedia(mediaId);
  if (!media) throw new TranscodeSubmitError("not_found", `媒资不存在：${mediaId}`, 404);
  const sourceKey = media.sourceKey ?? (await deps.resolveOriginalKey(mediaId));
  if (!sourceKey) throw new TranscodeSubmitError("not_found", `媒资原始文件缺失，无法转码：${mediaId}`, 404);

  // 逐个模板取回并校验非法组合（ADR-0014：模板保存与任务发起各拦一次）——任一非法则整批拒绝
  const templates: Array<z.infer<typeof TranscodeTemplateDTO>> = [];
  const snapshots: Array<SubmitJobRow["templateSnapshot"]> = [];
  for (const templateId of templateIds) {
    const template = await deps.getTemplate(templateId).catch((e) => rethrowBusiness(e));
    const snapshot = await snapshotForTemplate(template, deps.getWatermark).catch((e) => rethrowBusiness(e));
    templates.push(template);
    snapshots.push(snapshot);
  }

  // 冲突检查：同一媒资 + **同一模板** 只允许一个未终结任务（不同模板产物分树存放，可并行，spec.md §5.1）
  const running = await deps.listActiveJobs(mediaId);
  // CEK 轮换进行中 → 整个媒资冻结：普通任务会复用旧 CEK 产出新密文，轮换落库后即失效（spec.md §4.4）
  if (running.some((r) => r.keyPlan != null)) {
    throw new TranscodeSubmitError(
      "bad_request",
      `媒资正在进行 CEK 密钥轮换（重转码），请等待轮换任务完成后再发起转码`,
      409,
    );
  }
  const runningByTemplate = new Map(running.map((r) => [r.templateId ?? "", r.id]));
  const conflicts = templates.filter((t) => runningByTemplate.has(t.id));
  if (conflicts.length) {
    const detail = conflicts.map((t) => `「${t.name}」（任务 ${runningByTemplate.get(t.id)}）`).join("、");
    throw new TranscodeSubmitError(
      "bad_request",
      `以下模板已有进行中的转码任务：${detail}，请等待其完成或失败后再发起`,
      409,
    );
  }

  // 每个模板各入队一条任务（整批同一事务内创建）；产物各落 proceed/{mediaId}/{templateId}/
  const created = await deps.createJobs(
    templates.map((template, i) => ({
      mediaId,
      status: "QUEUED" as const,
      templateId: template.id,
      templateSnapshot: snapshots[i],
    })),
  );

  return {
    jobs: templates.map((template, i) => ({
      job_id: created[i].id,
      template_id: template.id,
      template_name: template.name,
      watermark_id: snapshots[i].watermark?.id ?? null,
      status: "QUEUED" as const,
    })),
  };
}

/** 重启时可读到的「当前配置」（装配由调用方注入） */
export interface RestartSnapshotDeps {
  getTemplate(id: string): Promise<z.infer<typeof TranscodeTemplateDTO>>;
  getWatermark(id: string): Promise<z.infer<typeof WatermarkTemplateDTO>>;
}

/**
 * 重启任务时按**当前**模板 / 水印重建快照（2026-11-15 用户定）：
 * 改完模板再重启，用的就是新参数，不必回媒资页重新发起转码。
 * 边界：
 *   - 模板已删（templateId 空 / 查不到）或水印已删 → 没有「最新配置」可读，沿用入队时快照，不阻断重启；
 *   - 新模板配置本身非法（keep_original + 水印 / 图片水印未传图）→ 上抛，要求先修模板；
 *   - CEK 轮换任务（keyPlan 非空）→ 新模板必须仍加密，否则 key_plan 不被消费，轮换会停在半路（spec.md §4.4）。
 */
export async function rebuildSnapshotForRestart(
  job: { templateId: string | null; templateSnapshot: unknown; keyPlan: unknown },
  deps: RestartSnapshotDeps,
): Promise<{ snapshot: unknown; refreshed: boolean }> {
  if (!job.templateId) return { snapshot: job.templateSnapshot, refreshed: false };
  try {
    const template = await deps.getTemplate(job.templateId);
    if (job.keyPlan != null && !template.encrypt) {
      throw new TranscodeSubmitError(
        "bad_request",
        `任务属于 CEK 轮换批次，模板「${template.name}」必须保持加密，请改回后再重启`,
        409,
      );
    }
    return { snapshot: await snapshotForTemplate(template, deps.getWatermark), refreshed: true };
  } catch (e) {
    if (e instanceof TranscodeSubmitError) throw e;
    // 模板 / 水印已被删除：沿用它入队时的快照（保持「模板删除后仍可重跑」）
    return { snapshot: job.templateSnapshot, refreshed: false };
  }
}
