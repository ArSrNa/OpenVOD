// 错误模型（player-sdk-spec.md §8）：DeliveryError 保真透出服务端错误（不变量 N4），
// PlayerSdkError 承载 SDK 自身错误。错误码类型以 **type-only** 引用契约 ErrorCode
// （唯一真相源 packages/contracts，编译期防漂移）；运行时提示表在下方手工维护，
// test/errors.test.ts 与 @openvod/shared ERROR_CODES 逐字断言（dev 依赖，不进运行时）。
import type { ErrorCode, z } from "@openvod/contracts";

/** 服务端错误码（api.md §0.2 全表；契约 `ErrorCode` 的 TS 联合） */
export type DeliveryErrorCode = z.infer<typeof ErrorCode>;

/**
 * 错误码 → 排查建议表（api.md §2 错误码表同源；`describeError` 的唯一数据源）。
 * 键集必须与契约 `ErrorCode` 全表一致（单测门禁）。
 */
export const ERROR_HINTS: Record<DeliveryErrorCode, string> = {
  unauthorized:
    "登录态无效或已过期：SDK 对业务请求会自动重登一次并重试；二次仍失败说明账号被禁 / 口令已变（static 模式需重新注入 token）。",
  invalid_credentials:
    "账号或口令错误（SDK 不清空已配置凭据）：修正后用 setCredential() 更新凭据再重试。",
  forbidden: "请求被拒绝：检查分发端 CORS 来源限制与平台侧访问策略。",
  bad_request:
    "请求参数不合法：检查 mediaId / templateId 是否来自分发端响应（templateId 一律取 handle.templates[].id，不要手拼）。",
  bad_token:
    "播放 token 无效 / 已过期 / 会话已吊销：SDK 对自身资源请求（字幕）会自动重签一次；播放器内部清单 / 密钥 / 分片 403 请调用 handle.refresh() 换源。",
  not_found: "资源不存在（媒资 / 字幕轨道 / 清单对象已被删除）：回列表或重新获取。",
  not_playable: "媒资未就绪或指定模板无产物：回列表，或从 handle.templates 重新选择清晰度。",
  session_limit:
    "并发播放会话已达上限（force_new 不绕过上限，仅新建会话时检查）：等待旧会话按 TTL 自然过期，或在管理端调大该用户 max_concurrent_sessions。",
  rate_limited: "请求过于频繁：退避后重试（v1 分发端未启用限频，保留码）。",
  not_implemented: "该端点未实现 / 未配置：检查分发端版本与管理端预览账号等配置。",
  internal:
    "服务端或网络异常：稍后重试（GET 类请求可经 retries 自动重试）；status=0 表示网络层失败——常见于分发端未启动或 CORS 未放行当前源站。",
};

/** 错误码 → 排查建议（未知码给出兜底文案；仅用于提示，不参与任何安全判断） */
export function describeError(code: string | null | undefined): string {
  if (!code) return "缺少错误码：请检查网络与分发端日志。";
  return ERROR_HINTS[code as DeliveryErrorCode] ?? `未知错误码：${code}（可能是分发端新增，请对照 api.md §0.2）`;
}

/** 分发端错误（服务端错误码 / 网络失败统一形态） */
export class DeliveryError extends Error {
  /** 服务端错误码（api.md §0.2 全表）；网络 / 超时 / 非 JSON 响应统一 "internal" */
  readonly code: DeliveryErrorCode;
  /** HTTP 状态码；网络层失败 = 0 */
  readonly status: number;
  /** SDK 附加排查建议（不覆盖服务端 message，见 §8） */
  readonly hint?: string;

  constructor(code: DeliveryErrorCode, message: string, status: number, hint?: string) {
    super(message);
    this.name = "DeliveryError";
    this.code = code;
    this.status = status;
    this.hint = hint ?? describeError(code);
  }
}

/** SDK 自身错误码 */
export type PlayerSdkErrorCode = "sdk_invalid_config" | "sdk_no_credential" | "sdk_disposed" | "sdk_bad_response";

/** SDK 自身错误（配置非法 / 无凭据 / 已 dispose / 关键响应结构无法解析） */
export class PlayerSdkError extends Error {
  readonly code: PlayerSdkErrorCode;

  constructor(code: PlayerSdkErrorCode, message: string) {
    super(message);
    this.name = "PlayerSdkError";
    this.code = code;
  }
}

/** 任意抛错 → SDK 错误形态（事件 payload 用；未知抛错统一包装为 internal/0） */
export function toSdkError(error: unknown): DeliveryError | PlayerSdkError {
  if (error instanceof DeliveryError || error instanceof PlayerSdkError) return error;
  return new DeliveryError("internal", error instanceof Error ? error.message : String(error), 0);
}
