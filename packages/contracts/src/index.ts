// API 契约唯一真相源（ADR-0001 / ADR-0010）
// zod schema → JSON Schema（scripts/gen-json.ts）→ Go struct（scripts/gen-go.sh，quicktype）
// 生成物提交入库，CI 以 `bun run check:contracts-go` 门禁防漂移。

import { z } from "zod";
import { ERROR_CODES } from "@openvod/shared";

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
});

export const PlaybackResponse = z.object({
  sid: z.string(),
  /** 签名主清单 URL（EO TypeA + 分发端 token，ADR-0005/0006） */
  manifest_url: z.string(),
  expires_at: z.string(), // ISO 8601
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

/** 分辨率档位：固定宽×高 或 自适应上限约束（intent.md「转码模板管理」规则 2：等比缩放） */
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

// 管理端 / Worker 直接复用同一份 zod 实例做请求校验（避免各包重复声明 zod 依赖）
export { z } from "zod";
