// 发起转码的编排核心（**多选**模板，ADR-0014）：一次提交 → 每个模板各入队一条任务。
// 本模块只依赖 contracts（zod）：DB / 存储 / 模板查询全部经 deps 注入，
// 无 next/db/模板运行时依赖，便于纯单测（不起 mock、不连库）。
import {
  TranscodeSubmitRequest,
  TranscodeSubmitResponse,
  TranscodeTemplateDTO,
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
  /** 查询该媒资未终结任务（同模板冲突判定用） */
  listActiveJobs(mediaId: string): Promise<Array<{ id: string; templateId: string | null }>>;
  /** 批量创建任务（同一事务）；返回顺序须与入参一致 */
  createJobs(rows: SubmitJobRow[]): Promise<Array<{ id: string }>>;
}

/** 模板快照（ADR-0014 防漂移）：Worker 只吃快照，模板后续改删不影响本任务 */
function snapshotOf(template: z.infer<typeof TranscodeTemplateDTO>): SubmitJobRow["templateSnapshot"] {
  return {
    template_id: template.id,
    name: template.name,
    keep_original: template.keep_original,
    encrypt: template.encrypt,
    format: template.format,
    params: template.params,
  };
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
  for (const templateId of templateIds) {
    const template = await deps.getTemplate(templateId).catch((e) => rethrowBusiness(e));
    if (template.encrypt && template.format !== "HLS") {
      throw new TranscodeSubmitError("bad_request", `模板「${template.name}」选择了加密，输出格式必须为 HLS`, 400);
    }
    templates.push(template);
  }

  // 冲突检查：同一媒资 + **同一模板** 只允许一个未终结任务（不同模板产物分树存放，可并行，spec.md §5.1）
  const running = await deps.listActiveJobs(mediaId);
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
    templates.map((template) => ({
      mediaId,
      status: "QUEUED" as const,
      templateId: template.id,
      templateSnapshot: snapshotOf(template),
    })),
  );

  return {
    jobs: templates.map((template, i) => ({
      job_id: created[i].id,
      template_id: template.id,
      template_name: template.name,
      status: "QUEUED" as const,
    })),
  };
}
