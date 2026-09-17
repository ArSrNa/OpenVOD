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
