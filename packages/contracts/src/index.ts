// API 契约唯一真相源（ADR-0001 / ADR-0010）
// zod schema → JSON Schema（scripts/gen-json.ts）→ Go struct（scripts/gen-go.sh，quicktype）
// 生成物提交入库，CI 以 `bun run check:contracts-go` 门禁防漂移。

import { z } from "zod";
import { ERROR_CODES, SUBTITLE_LABEL_MAX } from "@openvod/shared";

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

export const MediaListItem = z.object({
  id: z.string(),
  title: z.string(),
  poster_url: z.string().nullable(),
  duration_ms: z.number().int().nullable(),
  /** 自定义公开字段白名单（管理端配置，ADR-0004 media.customData） */
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

/** 分辨率档位：固定宽×高 或 自适应上限约束（intent.md「转码模板管理」规则 4：等比缩放） */
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
});

export const CreateTranscodeTemplateRequest = TranscodeTemplateInput.extend({
  keep_original: z.boolean().default(false),
  encrypt: z.boolean().default(false),
  format: z.enum(TEMPLATE_FORMATS).default("HLS"),
  is_default: z.boolean().default(false),
}).refine((v) => v.keep_original || v.params != null, {
  message: "非保持原视频模板必须提供 params",
  path: ["params"],
});

/** PATCH 语义：字段缺省 = 不修改（不带默认值，避免误改） */
export const UpdateTranscodeTemplateRequest = TranscodeTemplateInput.partial();

// ---- 转码任务（M2，ADR-0008/0014；仅管理端与 Worker 消费，Go 分发端不消费 → 不进 gen-json 清单） ----

/** transcode_jobs.status 取值（与 Prisma `JobStatus` 枚举逐字一致） */
export const JOB_STATUSES = ["QUEUED", "PROBING", "ENCODING", "PACKAGING", "DONE", "FAILED"] as const;

/** 发起任务时写入 `transcode_jobs.template_snapshot` 的模板快照（防漂移：模板后续改删不影响已入队任务） */
export const TranscodeTemplateSnapshot = z.object({
  template_id: z.string(),
  name: z.string(),
  keep_original: z.boolean(),
  encrypt: z.boolean(),
  format: z.enum(TEMPLATE_FORMATS),
  params: TranscodeTemplateParams.nullable(),
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
  /** 分发端是否持有有效租约（执行中）；未认领 / worker 失联（租约过期）时为 false —— 「停止」操作的依据 */
  lease_active: z.boolean(),
  last_error: z.string().nullable(),
  created_at: z.string(),
  started_at: z.string().nullable(),
  finished_at: z.string().nullable(),
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
  display_name: z.string().trim().max(64).optional(),
  max_concurrent_sessions: UserMaxConcurrentSessions.default(0),
  status: z.enum(USER_STATUSES).default("ACTIVE"),
});

/** PATCH 语义：字段缺省 = 不修改；display_name 传 null = 清空展示名 */
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
