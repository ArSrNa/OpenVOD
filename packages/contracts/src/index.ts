// API 契约唯一真相源（ADR-0001 / ADR-0010）
// zod schema → JSON Schema（scripts/gen-json.ts）→ Go struct（scripts/gen-go.sh，quicktype）
// 生成物提交入库，CI 以 `bun run check:contracts-go` 门禁防漂移。

import { z } from "zod";
import {
  ERROR_CODES,
  MEDIA_CATEGORY_DESCRIPTION_MAX,
  MEDIA_CATEGORY_NAME_MAX,
  MEDIA_CATEGORY_SORT_MAX,
  MEDIA_DESCRIPTION_MAX,
  MEDIA_TAGS_MAX,
  MEDIA_TAG_LENGTH_MAX,
  SUBTITLE_LABEL_MAX,
  WATERMARK_ANCHORS,
  WATERMARK_TEXT_MAX,
  WATERMARK_BLEND_MODES,
  WATERMARK_DESCRIPTION_MAX,
  WATERMARK_FONTS,
  WATERMARK_NAME_MAX,
  WATERMARK_OFFSET_MAX,
  WATERMARK_SHADOW_OFFSET_MAX,
} from "@openvod/shared";

// ---- 错误信封（ADR-0010：失败统一 { error: { code, message } }） ----
export const ErrorCode = z.enum(ERROR_CODES);
export const ErrorEnvelope = z.object({
  error: z.object({
    code: ErrorCode,
    message: z.string(),
  }),
});

// ---- 登录（ADR-0007：分发端签发 JWT） ----
export const LoginRequest = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});

export const LoginResponse = z.object({
  access_token: z.string(),
  token_type: z.literal("Bearer"),
  expires_in: z.number().int(),
  kid: z.string(),
});

// ---- 媒体元数据（ADR-0010） ----
export const MediaSubtitleDTO = z.object({
  id: z.string(),
  lang: z.string(), // BCP-47
  label: z.string(),
  is_default: z.boolean(),
});

/** 播放链路字幕轨道（play 返回；spec.md §7.5）：url 为带 typ=v 签名 token 的 .vtt 地址 */
export const PlaybackSubtitleDTO = MediaSubtitleDTO.extend({
  url: z.string(),
});

/**
 * 播放链路可用模板产物（play 返回；spec.md §11.1）：「清晰度」选项 = 存储实际存在的模板子树
 * （`proceed/{id}/{templateId}/`，「有什么放什么」；旧布局 / 无产物为 `[]`）。
 * `.meta` 内联 title 让 quicktype 生成 Go 类型名 `PlaybackTemplate` —— 否则会与
 * `PlaybackTemplateDTO` 在同一个 Go 包里逻辑重复命名别扭（同 PlaybackSubtitle 处理）。
 */
export const PlaybackTemplateDTO = z
  .object({
    /** 模板 ID（cuid 形状）；即 play 请求 template_id 的可用取值 */
    id: z.string(),
    /** transcode_templates.name 当前名称（非任务快照）；模板行已删除（历史产物）为 null */
    name: z.string().nullable(),
    /** 管理端标记的默认模板（仅展示用；自动选择语义仍按 spec.md §6.3） */
    is_default: z.boolean(),
  })
  .meta({ title: "PlaybackTemplate" });

export const MediaListItem = z.object({
  id: z.string(),
  title: z.string(),
  poster_url: z.string().nullable(),
  duration_ms: z.number().int().nullable(),
  /** 自定义元数据公开白名单（`category` / `description` / `tags`，spec.md §8.4；ADR-0004 media.customData） */
  custom: z.record(z.string(), z.unknown()).nullable(),
});

export const MediaDetail = MediaListItem.extend({
  status: z.string(),
  /** 系统 probe 元数据摘要（时长/分辨率/编码，来自 ffprobe，ADR-0008） */
  probe: z
    .object({
      width: z.number().int().nullable(),
      height: z.number().int().nullable(),
      video_codec: z.string().nullable(),
      audio_codec: z.string().nullable(),
      bitrate_bps: z.number().int().nullable(),
    })
    .nullable(),
  subtitles: z.array(MediaSubtitleDTO),
  playable: z.boolean(),
});

// ---- 播放会话（ADR-0006 / 0007） ----
export const PlaybackRequest = z.object({
  /** 同媒资未过期会话默认复用；true 则强制新会话 */
  force_new: z.boolean().optional(),
  /** 指定播放哪套模板产物（proceed/{id}/{templateId}/）；省略时自动选择：唯一产物直接用，多套取默认模板产物 */
  template_id: z.string().nullable().optional(),
});

export const PlaybackResponse = z.object({
  sid: z.string(),
  /** 签名主清单 URL（分发端 token；query `t` 为清单 token，另带 `tpl` 指明模板产物） */
  manifest_url: z.string(),
  expires_at: z.string(), // ISO 8601
  /** 实际选用的模板产物 ID；旧布局产物（无模板段）为空字符串 */
  template_id: z.string(),
  /**
   * 就绪字幕轨道（含签名 URL；空数组 = 该媒资无字幕，spec.md §7.5）。
   * 内联 title 让 quicktype 生成 Go 类型名 `PlaybackSubtitle` —— 否则会与 MediaDetail
   * 内联出的 `Subtitle` 在同一个 Go 包里重名。
   */
  subtitles: z.array(PlaybackSubtitleDTO.meta({ title: "PlaybackSubtitle" })),
  /** 该媒资实际存在的模板产物列表（spec.md §11.1，恒为数组；旧布局为 `[]`）。清晰度切换用 */
  templates: z.array(PlaybackTemplateDTO),
});

export const PageQuery = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export const PageResponse = z.object({
  items: z.array(MediaListItem),
  next_cursor: z.string().nullable(),
});

// ---- 转码模板（ADR-0014；管理端与 Worker 共用校验。Go 分发端不消费模板，
// 故本节 schema 不进 gen-json.ts 清单、不生成 Go struct） ----

/**
 * 分辨率档位：固定宽×高 / 自适应上限约束（intent.md「转码模板管理」规则 4：等比缩放）/
 * 保持原分辨率（2026-10-05 增）——恒取源分辨率、不缩放，是否执行由帧率 / 码率维度判定。
 */
export const TemplateResolution = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("fixed"),
    width: z.number().int().min(16).max(7680),
    height: z.number().int().min(16).max(4320),
  }),
  z.object({
    mode: z.literal("adaptive"),
    max_width: z.number().int().min(16).max(7680).optional(),
    max_height: z.number().int().min(16).max(4320).optional(),
  }),
  /** 保持原分辨率：无参数，编译期取源尺寸且不写 scale 滤镜（与「保持原视频配置」不同——仍重编码） */
  z.object({ mode: z.literal("source") }),
]);

/** x264/x265 速度档（ffmpeg preset） */
export const ENCODER_PRESETS = [
  "ultrafast",
  "superfast",
  "veryfast",
  "faster",
  "fast",
  "medium",
  "slow",
  "slower",
  "veryslow",
] as const;

/** 模板结构化参数（transcode_templates.params JSON 的形状；Worker 编译 argv 的唯一输入之一） */
export const TranscodeTemplateParams = z
  .object({
    /** ffmpeg 视频编码器（v1 主用 x264/x265；keep_original 模板不重编码，忽略此字段） */
    codec: z.enum(["libx264", "libx265"]),
    /** 视频码率 kbps（与 crf 二选一，见 refine） */
    bitrate_kbps: z.number().int().min(100).max(200_000).optional(),
    /** CRF 恒定质量模式（x264/x265 语义 0–51） */
    crf: z.number().int().min(0).max(51).optional(),
    /** 目标帧率（降帧率用；省略 = 保持源帧率） */
    fps: z.number().int().min(1).max(240).optional(),
    preset: z.enum(ENCODER_PRESETS).optional(),
    /** 分辨率档位（≥1 条 = 单档或 ABR ladder；固定或自适应约束） */
    resolutions: z.array(TemplateResolution).min(1).max(10),
    /** 音频 AAC 码率 kbps */
    audio_bitrate_kbps: z.number().int().min(32).max(320).default(128),
  })
  .superRefine((v, ctx) => {
    if (v.bitrate_kbps != null && v.crf != null) {
      ctx.addIssue({
        code: "custom",
        message: "bitrate_kbps 与 crf 只能二选一",
        path: ["bitrate_kbps"],
      });
    }
    if (v.bitrate_kbps == null && v.crf == null) {
      ctx.addIssue({
        code: "custom",
        message: "bitrate_kbps 与 crf 必须提供其一",
        path: ["bitrate_kbps"],
      });
    }
    v.resolutions.forEach((r, i) => {
      if (r.mode === "adaptive" && r.max_width == null && r.max_height == null) {
        ctx.addIssue({
          code: "custom",
          message: "自适应分辨率至少提供 max_width 或 max_height",
          path: ["resolutions", i],
        });
      }
    });
  });

export const TEMPLATE_FORMATS = ["HLS"] as const;

/** 模板 DTO（API 输出形状；keep_original=true 时 params 可为 null —— 只加密流程无重编码参数） */
export const TranscodeTemplateDTO = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  keep_original: z.boolean(),
  encrypt: z.boolean(),
  format: z.enum(TEMPLATE_FORMATS),
  params: TranscodeTemplateParams.nullable(),
  is_default: z.boolean(),
  /** 关联的水印模板 ID（spec.md §10.4；null = 不烧录水印；keep_original=true 时恒为 null） */
  watermark_id: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});

/** 模板字段基础对象（无默认值；create 附加默认值，update 取 partial —— zod v4 禁止对带 refine 的 schema 调 .partial()） */
const TranscodeTemplateInput = z.object({
  name: z.string().trim().min(1, "模板名不能为空").max(100),
  description: z.string().max(500).optional(),
  keep_original: z.boolean(),
  encrypt: z.boolean(),
  format: z.enum(TEMPLATE_FORMATS),
  params: TranscodeTemplateParams.optional(),
  is_default: z.boolean(),
  /** 关联水印模板（透传字段；显式 null = 解除关联；缺省 = 不修改） */
  watermark_id: z.string().min(1).nullable().optional(),
});

/**
 * keep_original（只加密，`-c copy`）与水印烧录互斥：无法在不解码的情况下叠加画面。
 * 任务发起侧再拦一次（spec.md §10.4「模板保存与任务发起两层校验」）。
 */
const assertNoWatermarkOnKeepOriginal = (v: { keep_original: boolean; watermark_id?: string | null }) =>
  !v.keep_original || v.watermark_id == null;

export const CreateTranscodeTemplateRequest = TranscodeTemplateInput.extend({
  keep_original: z.boolean().default(false),
  encrypt: z.boolean().default(false),
  format: z.enum(TEMPLATE_FORMATS).default("HLS"),
  is_default: z.boolean().default(false),
})
  .refine((v) => v.keep_original || v.params != null, {
    message: "非保持原视频模板必须提供 params",
    path: ["params"],
  })
  .refine(assertNoWatermarkOnKeepOriginal, {
    message: "「保持原视频配置」不重编码，无法烧录水印（请关闭保持原视频或取消水印关联）",
    path: ["watermark_id"],
  });

/** PATCH 语义：字段缺省 = 不修改（不带默认值，避免误改） */
export const UpdateTranscodeTemplateRequest = TranscodeTemplateInput.partial();

// ---- 水印模板（spec.md §10 / ADR-0018；管理端与 Worker 消费。Go 分发端不消费，
// 故本节 schema 不进 gen-json.ts 清单、不生成 Go struct） ----

// 常量自 @openvod/shared 导入（见文件头部 import），此处原样再导出供管理端 UI 复用
export { WATERMARK_ANCHORS, WATERMARK_BLEND_MODES, WATERMARK_FONTS };

/** 水印图片尺寸：显式像素宽高 或 占画面比例（宽 / 高分别按画面对应边的百分比；spec.md §10.1） */
export const WatermarkImageSize = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("pixels"),
    /** 两项给定时精确缩放（允许变形）；仅一项时按原图宽高比等比换算另一维 */
    width: z.number().int().min(1).max(7680).optional(),
    height: z.number().int().min(1).max(7680).optional(),
  }),
  z.object({
    mode: z.literal("percent"),
    /** 对应维 = 画面宽 / 高 × 百分比；仅一项时等比；两项时分别按对应边缩放（允许变形） */
    width: z.number().int().min(1).max(100).optional(),
    height: z.number().int().min(1).max(100).optional(),
  }),
]);

/** 文字水印字号：显式像素 或 输出高度百分比（spec.md §10.1） */
export const WatermarkTextSize = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("pixels"), size: z.number().int().min(4).max(512) }),
  z.object({ mode: z.literal("percent"), size: z.number().int().min(1).max(100) }),
]);

/** 文字阴影（可关闭）：颜色 + x / y 偏移（drawtext shadowcolor / shadowx / shadowy 语义） */
export const WatermarkShadow = z.object({
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/, "阴影颜色须为 #RRGGBB"),
  offset_x: z.number().int().min(-WATERMARK_SHADOW_OFFSET_MAX).max(WATERMARK_SHADOW_OFFSET_MAX),
  offset_y: z.number().int().min(-WATERMARK_SHADOW_OFFSET_MAX).max(WATERMARK_SHADOW_OFFSET_MAX),
});

/**
 * 水印参数（watermark_templates.params JSON 的形状，含 type 字面量自描述；
 * 快照自包含 —— 转码集成时随 template_snapshot 固化）。
 * 公共参数（anchor / 偏移 / opacity / blend）两类一致，专属参数按 type 判别。
 */
const watermarkCommon = {
  /** 九宫格锚点（spec.md §10.4 定位换算表） */
  anchor: z.enum(WATERMARK_ANCHORS),
  /** 锚点对齐后的带符号位移（x 正 = 右、y 正 = 下；右 / 下锚点常配负偏移做内边距） */
  offset_x: z.number().int().min(-WATERMARK_OFFSET_MAX).max(WATERMARK_OFFSET_MAX).default(0),
  offset_y: z.number().int().min(-WATERMARK_OFFSET_MAX).max(WATERMARK_OFFSET_MAX).default(0),
  /** 透明度 0–100（%），两种混合方式下均生效 */
  opacity: z.number().int().min(0).max(100).default(100),
  /** 混合方式：normal（标准 alpha 叠加）| overlay（Overlay 混合模式） */
  blend: z.enum(WATERMARK_BLEND_MODES).default("normal"),
} as const;

export const ImageWatermarkParams = z
  .object({ type: z.literal("image"), ...watermarkCommon, size: WatermarkImageSize })
  .superRefine((v, ctx) => {
    if (v.size.width == null && v.size.height == null) {
      ctx.addIssue({
        code: "custom",
        message: "水印尺寸至少提供宽或高",
        path: ["size"],
      });
    }
  });

export const TextWatermarkParams = z.object({
  type: z.literal("text"),
  ...watermarkCommon,
  /** 文字内容：1–64 字符，trim 后非空，不含控制字符（单行）；也不含 `'`——ffmpeg 滤镜选项分词器
   *  无法把字面单引号送进 drawtext（spec.md §10.1 / ADR-0018 转义约束） */
  text: z
    .string()
    .transform((s) => s.trim())
    .refine((s) => s.length >= 1 && s.length <= WATERMARK_TEXT_MAX, {
      message: `文字内容须为 1–${WATERMARK_TEXT_MAX} 个字符`,
    })
    .refine((s) => !/[\u0000-\u001f\u007f]/.test(s), { message: "文字内容不能包含控制字符" })
    .refine((s) => !s.includes("'"), { message: "文字内容不能包含单引号 '（ffmpeg drawtext 无法渲染该字符）" }),
  /** 字体（Worker 内置 Noto CJK 清单，@openvod/shared WATERMARK_FONTS） */
  font: z.enum(WATERMARK_FONTS),
  /** 文字颜色 #RRGGBB */
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/, "颜色须为 #RRGGBB"),
  /** 阴影：null = 无阴影（默认） */
  shadow: WatermarkShadow.nullable().default(null),
  size: WatermarkTextSize,
});

export const WatermarkParams = z.discriminatedUnion("type", [
  ImageWatermarkParams,
  TextWatermarkParams,
]);

export type WatermarkParamsValue = z.infer<typeof WatermarkParams>;

/** 水印模板 DTO（API 输出形状；image_* 列仅图片型有值，文字型恒 null） */
export const WatermarkTemplateDTO = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  type: z.enum(["image", "text"]),
  params: WatermarkParams,
  image_ext: z.string().nullable(),
  image_key: z.string().nullable(),
  image_bytes: z.number().int().nullable(),
  image_width: z.number().int().nullable(),
  image_height: z.number().int().nullable(),
  /** 图片可用性：text 恒 ready；image 型 missing = 尚未上传图片（不可被转码模板关联） */
  image_status: z.enum(["ready", "missing"]),
  /** 引用它的转码模板数（spec.md §10.3 一次 groupBy；>0 时删除返回 409） */
  referenced_by: z.number().int(),
  created_at: z.string(),
  updated_at: z.string(),
});

/** 模板字段基础对象（无默认值；create 附加默认值，update 取 partial） */
const WatermarkTemplateInput = z.object({
  name: z.string().trim().min(1, "模板名不能为空").max(WATERMARK_NAME_MAX),
  description: z.string().max(WATERMARK_DESCRIPTION_MAX).optional(),
  params: WatermarkParams,
});

/** 新建水印模板：type 由 params.type 判别（图片 / 文字专属参数互不可混） */
export const CreateWatermarkRequest = WatermarkTemplateInput;

/** PATCH 语义：字段缺省 = 不修改；params.type 必须与既有模板一致（服务端校验） */
export const UpdateWatermarkRequest = WatermarkTemplateInput.partial();

// ---- 转码任务（M2，ADR-0008/0014；仅管理端与 Worker 消费，Go 分发端不消费 → 不进 gen-json 清单） ----

/** transcode_jobs.status 取值（与 Prisma `JobStatus` 枚举逐字一致）。
 *  阶段顺序：排队中 → 探测中 → **拉取源片** → 转码中 → 封装上传中 → 完成（DOWNLOADING 为 2026-10-17 新增，
 *  源片拉取到本地与转码是两个阶段：转码输入本地文件，多档只下载一次，状态可区分）。
 *  CANCELLED 为 2026-11-12 新增（终结态）：管理端取消后由 Worker 中断执行并落库（spec.md §5.1）。 */
export const JOB_STATUSES = [
  "QUEUED",
  "PROBING",
  "DOWNLOADING",
  "ENCODING",
  "PACKAGING",
  "DONE",
  "FAILED",
  "CANCELLED",
] as const;

/** 未终结状态（认领候选 / 「进行中任务」统计 / 产物删除守卫共用；各消费方统一引用此常量） */
export const ACTIVE_JOB_STATUSES = ["QUEUED", "PROBING", "DOWNLOADING", "ENCODING", "PACKAGING"] as const;

/**
 * 任务快照中的水印段（spec.md §10.4 / ADR-0018）：**自包含**——submit 时把水印模板内容
 * （含图片元数据）固化进 transcode_jobs.template_snapshot.watermark，模板 / 图片后续变更
 * 不影响已入队任务；Worker 只读快照，不回查 watermark_templates。
 */
export const WatermarkSnapshot = z.object({
  id: z.string(),
  name: z.string(),
  type: z.enum(["image", "text"]),
  params: WatermarkParams,
  /** 图片型专属（文字型为 null）：Worker 据此预签名取图并作为 ffmpeg 第二输入 */
  image_key: z.string().nullable().optional(),
  image_ext: z.string().nullable().optional(),
  image_width: z.number().int().nullable().optional(),
  image_height: z.number().int().nullable().optional(),
});

export type WatermarkSnapshotValue = z.infer<typeof WatermarkSnapshot>;

/** 发起任务时写入 `transcode_jobs.template_snapshot` 的模板快照（防漂移：模板后续改删不影响已入队任务） */
export const TranscodeTemplateSnapshot = z
  .object({
    template_id: z.string(),
    name: z.string(),
    keep_original: z.boolean(),
    encrypt: z.boolean(),
    format: z.enum(TEMPLATE_FORMATS),
    params: TranscodeTemplateParams.nullable(),
    /** 关联水印快照（null / 缺省 = 不烧录水印） */
    watermark: WatermarkSnapshot.nullable().optional(),
  })
  .superRefine((v, ctx) => {
    // 「模板保存 + 任务发起」两层校验的 Worker 侧兜底：脏快照直接判不可执行，而不是产出错片
    if (v.keep_original && v.watermark != null) {
      ctx.addIssue({
        code: "custom",
        message: "keep_original 模板不能携带水印快照（不重编码无法烧录水印）",
        path: ["watermark"],
      });
    }
    if (v.watermark?.type === "image" && !v.watermark.image_key) {
      ctx.addIssue({
        code: "custom",
        message: "图片水印快照缺少 image_key（提交时水印图尚未上传）",
        path: ["watermark", "image_key"],
      });
    }
  });

/** submit 单次最多可选的模板数（每个模板各入队一条任务；products 各落 proceed/{mediaId}/{templateId}/） */
export const TRANSCODE_SUBMIT_MAX_TEMPLATES = 10;

/** 发起转码：**多选**模板（template_ids）。每个模板独立快照、各自入队一条 transcode_jobs（ADR-0014）。 */
export const TranscodeSubmitRequest = z.object({
  template_ids: z
    .array(z.string().min(1))
    .min(1, "请至少选择一个转码模板")
    .max(TRANSCODE_SUBMIT_MAX_TEMPLATES, `单次最多选择 ${TRANSCODE_SUBMIT_MAX_TEMPLATES} 个模板`),
});

/** 单条已入队任务（一个模板一条；便于 UI 逐个反馈） */
export const TranscodeSubmitJob = z.object({
  job_id: z.string(),
  template_id: z.string(),
  template_name: z.string(),
  /** 该任务快照里固化的水印（null = 不烧录水印；spec.md §10.4） */
  watermark_id: z.string().nullable(),
  status: z.enum(JOB_STATUSES),
});

export const TranscodeSubmitResponse = z.object({
  /** 已入队任务（顺序与请求 template_ids 去重后一致） */
  jobs: z.array(TranscodeSubmitJob),
});

/** 转码任务列表项（管理端「转码任务」页） */
export const TranscodeJobDTO = z.object({
  id: z.string(),
  media_id: z.string(),
  media_title: z.string().nullable(),
  status: z.enum(JOB_STATUSES),
  template_id: z.string().nullable(),
  /** 取快照里的模板名（模板被删也能追溯） */
  template_name: z.string().nullable(),
  attempts: z.number().int(),
  /** 当前阶段进度（0–100；DOWNLOADING / ENCODING 阶段有意义，其余为 null） */
  progress: z.number().int().min(0).max(100).nullable(),
  /** 分发端是否持有有效租约（执行中）；未认领 / worker 失联（租约过期）时为 false —— 「取消」操作的依据 */
  lease_active: z.boolean(),
  /** 取消请求提交时间（null = 未请求取消）；执行中的任务由 Worker 轮询到后立即中断并置 CANCELLED */
  cancel_requested_at: z.string().nullable(),
  last_error: z.string().nullable(),
  created_at: z.string(),
  started_at: z.string().nullable(),
  finished_at: z.string().nullable(),
});

/**
 * 任务日志尾部（管理端「日志」抽屉；ADR-0017 修订）。
 * Worker 每 2s 覆盖写 `transcode_jobs.log_tail` 并把 `log_seq` +1；客户端带 after=<上次 seq>，
 * 未变化时 tail 为 null（不回传 48KB 文本）。
 */
export const TranscodeJobLogsResponse = z.object({
  seq: z.number().int(),
  /** null = 自 after 起无更新，客户端保持现有内容 */
  tail: z.string().nullable(),
});

/**
 * Worker 唤醒请求（admin → worker，http / invoked 共用）。
 * `job_ids` 只被 invoked 模式消费（定向认领，不扫队列）；http 模式忽略载荷、照常 drain 队列。
 * admin 在多任务时**逐任务各发一次**（一次唤醒 = 一次异步实例，避免同实例串行被巡检误判）。
 */
export const WorkerWakeRequest = z.object({
  job_ids: z.array(z.string().min(1)).max(TRANSCODE_SUBMIT_MAX_TEMPLATES).optional(),
});

// ---- 密钥管理（spec.md §4.3；ADR-0006） ----
// 仅管理端消费：分发端 /key 返回裸字节（octet-stream）、Go 侧不消费任何 DTO，
// 故本节**不进 gen-json.ts 清单、不生成 Go struct**（同转码模板，ADR-0014）。
// P0 红线：本节所有 schema 都不含「明文 CEK / 封装 CEK」字段，从类型层杜绝密钥外泄。

/** 密钥列表项（含媒资展示信息；绝不含任何密钥材料） */
export const MediaKeyListItem = z.object({
  media_id: z.string(),
  title: z.string().nullable(),
  media_status: z.string().nullable(),
  kid: z.string(),
  method: z.string(),
  mk_ver: z.number().int(),
  created_at: z.string(),
  /** 该媒资 proceed 分区对象数（存储不可用时为 null，便于判断密钥是否真在被使用） */
  proceed_objects: z.number().int().nullable(),
});

/** 密钥详情（iv 是公开值：本就写在清单 EXT-X-KEY 中） */
export const MediaKeyDetail = MediaKeyListItem.extend({
  iv: z.string(),
  /** 未吊销且未过期的播放会话数（>0 = 密钥正在被使用，删除会被拒） */
  active_sessions: z.number().int(),
});

/** MK 版本状态：只暴露版本号与用量计数，不暴露任何密钥材料 */
export const MasterKeyStatus = z.object({
  active_ver: z.number().int(),
  versions: z.array(z.object({ ver: z.number().int(), keys: z.number().int() })),
  total_keys: z.number().int(),
});

export const RotateMasterKeysRequest = z.object({
  /** 只轮换来自该版本的行（省略 = 全部非 active 版本） */
  from_ver: z.number().int().positive().optional(),
});

export const RotateMasterKeysResponse = z.object({
  rotated: z.number().int(),
  failed: z.number().int(),
  to_ver: z.number().int(),
  /** 失败明细（仅 kid / media_id 与原因，不含密钥材料；最多返回 20 条） */
  errors: z.array(z.object({ media_id: z.string(), kid: z.string(), message: z.string() })).max(20),
});

// ---- 播放端用户管理（ADR-0004 users 表 / ADR-0007 账户域） ----
// 仅管理端消费（分发端用户读模型在 Go 侧独立对齐）：分发端 login 只按 username 查 users 表，
// 不消费本组 DTO，故本节**不进 gen-json.ts 清单、不生成 Go struct**（同转码模板 / 密钥管理）。

/** users.status 取值（与 Prisma `UserStatus` 枚举逐字一致） */
export const USER_STATUSES = ["ACTIVE", "DISABLED"] as const;

/** 播放端用户名：字母数字与 `.` `_` `-`，3–32 位 */
export const USERNAME_PATTERN = /^[a-zA-Z0-9._-]{3,32}$/;

/** 口令长度上限：bcrypt 只取前 72 字节，超出被静默丢弃（多字节字符截断还可能与校验端不一致），契约层直接拒绝 */
export const USER_PASSWORD_MAX_LENGTH = 72;

/** 并发播放会话上限上限值（ADR-0007：0 = 不限） */
export const MAX_CONCURRENT_SESSIONS_MAX = 10_000;

/** 用户 DTO（绝不包含 password_hash：管理端无查看口令哈希的入口） */
export const UserDTO = z.object({
  id: z.string(),
  username: z.string(),
  display_name: z.string().nullable(),
  status: z.enum(USER_STATUSES),
  /** 单用户并发播放会话上限，0 = 不限（ADR-0007） */
  max_concurrent_sessions: z
    .number()
    .int()
    .min(0)
    .max(MAX_CONCURRENT_SESSIONS_MAX),
  /** 未过期且未吊销的播放会话数（封禁 / 删除前的判断依据） */
  active_sessions: z.number().int(),
  /** 分发端 login 成功时刷新（ADR-0007） */
  last_login_at: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});

/** 口令字段（创建 / 重置密码共用）：≥8 位，≤72 字节） */
const UserPassword = z
  .string()
  .min(8, "密码至少 8 位")
  .max(USER_PASSWORD_MAX_LENGTH, `密码最多 ${USER_PASSWORD_MAX_LENGTH} 个字符`);

const UserMaxConcurrentSessions = z
  .number()
  .int()
  .min(0, "并发上限不能为负")
  .max(MAX_CONCURRENT_SESSIONS_MAX, `并发上限最大 ${MAX_CONCURRENT_SESSIONS_MAX}`);

/** 创建播放端用户（bcrypt 哈希后入库，ADR-0007） */
export const CreateUserRequest = z.object({
  username: z
    .string()
    .trim()
    .regex(USERNAME_PATTERN, "用户名需为 3–32 位字母、数字、`.`、`_` 或 `-`"),
  password: UserPassword,
  /** 可选：缺省 / null / 空串 = 默认沿用用户名（业务侧归一，见 apps/admin/src/lib/users.ts） */
  display_name: z.string().trim().max(64).nullish(),
  max_concurrent_sessions: UserMaxConcurrentSessions.default(0),
  status: z.enum(USER_STATUSES).default("ACTIVE"),
});

/** PATCH 语义：字段缺省 = 不修改；display_name 传 null / 空串 = 回退沿用用户名（与创建一致） */
export const UpdateUserRequest = z
  .object({
    display_name: z.string().trim().max(64).nullable().optional(),
    status: z.enum(USER_STATUSES).optional(),
    max_concurrent_sessions: UserMaxConcurrentSessions.optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: "没有需要更新的字段" });

/** 重置密码（管理员代重置，业务侧口令由 App 用户自行保管） */
export const ResetUserPasswordRequest = z.object({
  password: UserPassword,
});

export const UserListResponse = z.object({
  total: z.number().int(),
  items: z.array(UserDTO),
});

// ---- 字幕轨道管理（spec.md §7；ADR-0009）----
// 管理端消费整组（轨道 CRUD）；分发端只消费 PlaybackSubtitleDTO（随 play 下发）。
// 本组 DTO 仅管理端使用，**不进 gen-json.ts 清单、不生成 Go struct**（同模板 / 密钥 / 用户组）。

/** media_subtitles.status 取值（与 Prisma `SubtitleStatus` 枚举逐字一致；v1 上传同步校验，恒为 READY） */
export const SUBTITLE_STATUSES = ["PROCESSING", "READY", "FAILED"] as const;

/** 字幕轨道 DTO（管理端「字幕管理」抽屉；spec.md §7.4） */
export const SubtitleTrackDTO = z.object({
  /** trackId：同时是 media_subtitles.id、存储文件名与 API 路径参数（spec.md §7.1） */
  id: z.string(),
  /** BCP-47 语言标签（服务端归一化后的连字符形态，如 `zh-CN`） */
  lang: z.string(),
  label: z.string(),
  is_default: z.boolean(),
  status: z.enum(SUBTITLE_STATUSES),
  bytes: z.number().int(),
  /** 内容版本号（ADR-0009 2026-11-13 修订）：覆盖文本 +1；字幕签名 URL 携带 ?v= 该值 */
  content_version: z.number().int(),
  /** 相对存储键 proceed/{mediaId}/subtitles/{trackId}.vtt */
  storage_key: z.string(),
  /** 对应对象是否存在（存储不可用时为 null） */
  storage_ok: z.boolean().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});

/** PATCH 轨道元信息：字段缺省 = 不修改（语言走同一归一化与唯一校验） */
export const UpdateSubtitleTrackRequest = z
  .object({
    label: z.string().trim().min(1, "展示名不能为空").max(SUBTITLE_LABEL_MAX).optional(),
    lang: z.string().trim().min(2).max(35).optional(),
    is_default: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: "没有需要更新的字段" });

// ---- 媒资分类与自定义元数据（spec.md §8；ADR-0016）----
// 仅管理端消费：分发端不消费分类 DTO（自定义元数据经 `media.custom_data` 的**公开白名单**
// 输出，Go 侧手工对齐，见 spec.md §8.4）→ 本节**不进 gen-json.ts 清单、不生成 Go struct**
// （同转码模板 / 密钥 / 用户组）。

/** 分类节点 DTO（管理端「分类管理」页；层级由 `parent_id` 表达，客户端组树，spec.md §8.1） */
export const MediaCategoryDTO = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  /** 上级分类 ID；null = 顶级 */
  parent_id: z.string().nullable(),
  sort_order: z.number().int(),
  /** 系统内置分类（默认分类「其他」）：**不可删除**；未设置分类的媒资默认归入它（spec.md §8.1） */
  is_system: z.boolean(),
  /** 直属该分类的媒资数（不含子孙） */
  media_count: z.number().int(),
  /** 含子孙分类的媒资数（**保留字段**：当前管理端不展示，仅 API 返回） */
  descendant_media_count: z.number().int(),
  created_at: z.string(),
  updated_at: z.string(),
});

export const MediaCategoryListResponse = z.object({
  total: z.number().int(),
  items: z.array(MediaCategoryDTO),
});

/** 分类字段基对象（无默认值；create 附加默认值，update 取 partial —— zod v4 禁止对带 refine 的 schema 调 .partial()） */
const MediaCategoryInput = z.object({
  name: z
    .string()
    .trim()
    .min(1, "分类名不能为空")
    .max(MEDIA_CATEGORY_NAME_MAX, `分类名最多 ${MEDIA_CATEGORY_NAME_MAX} 个字符`),
  /** 分类自身的描述（管理端「分类管理」页；**与媒资的视频描述 `media.description` 无关**） */
  description: z
    .string()
    .trim()
    .max(MEDIA_CATEGORY_DESCRIPTION_MAX, `分类描述最多 ${MEDIA_CATEGORY_DESCRIPTION_MAX} 个字符`)
    .nullable()
    .optional(),
  /** 上级分类 ID；null / 缺省 = 顶级（移动时服务端校验环路，spec.md §8.1） */
  parent_id: z.string().nullable().optional(),
  sort_order: z.number().int().min(0).max(MEDIA_CATEGORY_SORT_MAX).optional(),
});

export const CreateMediaCategoryRequest = MediaCategoryInput.extend({
  sort_order: z.number().int().min(0).max(MEDIA_CATEGORY_SORT_MAX).default(0),
});

/** PATCH 语义：字段缺省 = 不修改；`description: null` = 清空描述；`parent_id: null` = 移到顶级 */
export const UpdateMediaCategoryRequest = MediaCategoryInput.partial().refine(
  (v) => Object.keys(v).length > 0,
  { message: "没有需要更新的字段" },
);

/** 标签数组（空白与去重由服务端 `normalizeMediaTags` 归一化；null / 空数组 = 清空） */
export const MediaTagsRequest = z
  .array(
    z
      .string()
      .trim()
      .min(1, "标签不能为空")
      .max(MEDIA_TAG_LENGTH_MAX, `单个标签最多 ${MEDIA_TAG_LENGTH_MAX} 个字符`),
  )
  .max(MEDIA_TAGS_MAX, `最多 ${MEDIA_TAGS_MAX} 个标签`);

/**
 * PATCH /api/admin/media/{id}：媒资字段部分更新（spec.md §8.2）。
 * `title` 走重命名语义（只改展示名）；`description` / `tags` / `category_id` 即「自定义元数据」设置；
 * `uploaded_at` 为自定义上传时间：**不进入**元数据投影与分发端下发，仅管理端展示 + 分发端列表排序回退（spec.md §3.1）。
 */
export const UpdateMediaRequest = z
  .object({
    title: z.string().trim().min(1, "展示名不能为空").max(191, "展示名过长（≤191 字符）").optional(),
    description: z
      .string()
      .trim()
      .max(MEDIA_DESCRIPTION_MAX, `描述最多 ${MEDIA_DESCRIPTION_MAX} 个字符`)
      .nullable()
      .optional(),
    tags: MediaTagsRequest.nullable().optional(),
    /** 归属分类 ID；null = 移出分类（分类必须存在，服务端校验） */
    category_id: z.string().nullable().optional(),
    /** 自定义上传时间（ISO 8601，UTC `Z` 或带时区偏移）；null = 恢复默认（回退存储对象原始写入时间） */
    uploaded_at: z
      .iso.datetime({ offset: true, error: "上传时间必须是合法的 ISO 8601 时间" })
      .nullable()
      .optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: "没有需要更新的字段" });

/**
 * 自定义元数据（管理端读取形态：三项**恒在**，空值分别为 null / null / []，便于表单回填）；
 * 下发形态（`custom_data` / 分发端 `custom`）为**稀疏投影**：空项不出现在 JSON 里（spec.md §8.3）。
 */
export const MediaCustomMetadataDTO = z.object({
  category: z.object({ id: z.string(), name: z.string(), path: z.string() }).nullable(),
  description: z.string().nullable(),
  tags: z.array(z.string()),
});

// ---- 控制台总览（spec.md §2.1；仅管理端使用，不生成 Go struct） ----
const DashboardCount = z.number().int().nonnegative();

export const DashboardStatsResponse = z.object({
  media: z.object({
    total: DashboardCount,
    ready: DashboardCount,
    not_ingested: DashboardCount,
  }),
  jobs: z.object({
    active: DashboardCount,
    queued: DashboardCount,
    probing: DashboardCount,
    /** 拉取源片中的任务数（2026-10-17） */
    downloading: DashboardCount,
    encoding: DashboardCount,
    packaging: DashboardCount,
  }),
  users: z.object({
    total: DashboardCount,
    active: DashboardCount,
    disabled: DashboardCount,
  }),
  storage: z.object({
    /** 当前 root 下四个业务分区的对象大小总和，包含 HLS 分片 */
    used_bytes: DashboardCount,
  }),
  subtitles: z.object({
    total: DashboardCount,
    media_count: DashboardCount,
  }),
  products: z.object({
    /** 按媒资 × 模板计组数；旧布局按每媒资一组，字幕不计入 */
    total: DashboardCount,
    media_count: DashboardCount,
  }),
  metadata: z.object({
    total: DashboardCount,
    probe: DashboardCount,
    custom: DashboardCount,
    other: DashboardCount,
  }),
});

export type DashboardStats = z.infer<typeof DashboardStatsResponse>;

// 管理端 / Worker 直接复用同一份 zod 实例做请求校验（避免各包重复声明 zod 依赖）
export { z } from "zod";
