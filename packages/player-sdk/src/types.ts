// 公共 DTO 类型（播放器 SDK 对外契约）。
//
// 唯一真相源是 `packages/contracts` 的 zod schema（ADR-0001 / ADR-0010）；这里是**自包含镜像**：
// 发布包（npm 官方 / CNB 制品库）必须零依赖——声明文件里不能出现 `@openvod/*` 的 import，
// 否则消费者不装私有包就解析不了类型（tsup dts 打包也无法内联 workspace 私有包）。
// 一致性由两道门禁守住：`bun run typecheck` 的编译期双向可赋值断言（test/contract-parity.ts）
// + `bun test` 对 ERROR_CODES 的逐字比对（test/errors.test.ts）。改契约 → 这里的镜像必须同步。

/** `GET /v1/media` 列表项（恒为 READY 媒资） */
export interface MediaListItem {
  id: string;
  title: string;
  poster_url: string | null;
  duration_ms: number | null;
  /** 自定义元数据公开白名单（spec.md §8.4）；展示前用 `parseCustomMetadata` 收敛 */
  custom: Record<string, unknown> | null;
}

/** ffprobe 摘要（系统 probe 元数据，ADR-0008） */
export interface MediaProbe {
  width: number | null;
  height: number | null;
  video_codec: string | null;
  audio_codec: string | null;
  bitrate_bps: number | null;
}

/** 字幕轨道元信息（无 URL；播放链路用 `PlaybackSubtitle`） */
export interface MediaSubtitle {
  id: string;
  /** BCP-47 */
  lang: string;
  label: string;
  is_default: boolean;
}

/** `GET /v1/media/{id}` 详情（非 READY 仍返回详情，`playable=false`） */
export interface MediaDetail extends MediaListItem {
  status: string;
  probe: MediaProbe | null;
  subtitles: MediaSubtitle[];
  playable: boolean;
}

/** `GET /v1/media` 分页响应（`next_cursor` v1 恒 null，原样透传） */
export interface MediaPage {
  items: MediaListItem[];
  next_cursor: string | null;
}

/** 播放链路字幕轨道（play 下发）：`url` 为带 `typ=v` 签名 token 的 .vtt 地址 */
export interface PlaybackSubtitle extends MediaSubtitle {
  /** 签名 URL（原样透出，SDK 不拼接不裁剪） */
  url: string;
}

/** 清晰度选项 = 该媒资实际存在、且管理端对播放端展示的模板产物（旧布局为 `[]`） */
export interface PlaybackTemplate {
  id: string;
  /** 模板行已删除（历史产物）为 null */
  name: string | null;
  /** 该媒资的有效默认产物（媒资级默认 → 全局默认模板）；未指定 templateId 时加载这套 */
  is_default: boolean;
}

/** `POST /v1/media/{id}/play` 请求体（SDK 内部组装；`templateId` → `template_id` 单点映射） */
export interface PlaybackRequest {
  /** 同媒资未过期会话默认复用；true 强制新会话（仍受并发上限约束） */
  force_new?: boolean;
  /** 指定模板产物；`""` = 显式请求旧布局产物，缺省 = 服务端自动选择 */
  template_id?: string | null;
}

/** 服务端错误码（api.md §0.2 全表；与共享包 ERROR_CODES、契约 ErrorCode 逐字对齐） */
export type DeliveryErrorCode =
  | "unauthorized"
  | "invalid_credentials"
  | "forbidden"
  | "bad_request"
  | "bad_token"
  | "not_found"
  | "not_playable"
  | "session_limit"
  | "rate_limited"
  | "not_implemented"
  | "internal";
