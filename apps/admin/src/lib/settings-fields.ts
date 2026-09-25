import { MEDIA_ID_CONFIG, SETTING_TTL_LIMITS } from "@openvod/shared";

export interface SettingField {
  key: string;
  label: string;
  type: "text" | "number" | "secret" | "boolean";
  help?: string;
  min?: number;
  max?: number;
  placeholder?: string;
}
const ttl = (key: keyof typeof SETTING_TTL_LIMITS, label: string): SettingField => ({ key, label, type: "number", ...SETTING_TTL_LIMITS[key] });

export const SETTINGS_GROUPS = {
  playback: {
    title: "播放设置",
    description: "设置分发域名、播放有效期、跨域来源和控制台预览账号。",
    fields: [
      { key: "playback_base_url", label: "分发端公开地址", type: "text", placeholder: "https://delivery.example.com", help: "清单、密钥和字幕的访问基址；留空回退 DELIVERY_PUBLIC_BASE_URL。" },
      ttl("jwt_ttl_sec", "播放端 JWT 有效期（秒）"),
      ttl("playback_session_ttl_sec", "播放会话有效期（秒）"),
      { ...ttl("playback_manifest_ttl_sec", "清单签名有效期（秒）"), help: "同时用于分片预签名，最长 7 天，且不能超过播放会话有效期。" },
      ttl("playback_subtitle_ttl_sec", "字幕签名有效期（秒）"),
      { key: "cors_origins", label: "播放端跨域来源", type: "text", help: "使用 *，或逗号分隔的完整来源，如 https://app.example.com；不包含路径。" },
      { key: "delivery_preview_username", label: "控制台预览账号", type: "text", help: "填写已创建的播放端用户，仅用于控制台的产物播放预览。" },
      { key: "delivery_preview_password", label: "预览账号口令", type: "secret", help: "不回显已有口令；留空保持不变。" },
    ],
  },
  storage: {
    title: "存储设置",
    description: "配置 S3 兼容存储（COS / MinIO）。更换桶或根前缀不会迁移已有资产，已有媒资可能暂时不可访问。",
    fields: [
      { key: "s3_endpoint", label: "S3 Endpoint", type: "text", placeholder: "https://cos.ap-shanghai.myqcloud.com" },
      { key: "s3_region", label: "Region", type: "text", placeholder: "ap-shanghai" },
      { key: "s3_bucket", label: "Bucket", type: "text" },
      { key: "s3_access_key_id", label: "Access Key ID", type: "text" },
      { key: "s3_secret_access_key", label: "Secret Access Key", type: "secret", help: "密钥经主密钥封装后保存；不会返回浏览器。" },
      { key: "s3_force_path_style", label: "Path-style 寻址", type: "boolean", help: "MinIO 通常启用；COS 按桶实际访问方式配置。" },
      { key: "storage_root_prefix", label: "资产根前缀", type: "text", placeholder: "openvod", help: "可为空（桶根）；不允许 .. 或反斜线。" },
      { key: "storage_cdn_base_url", label: "存储加速域名", type: "text", placeholder: "https://cdn.example.com", help: "可选，替换预签名对象 URL 的来源；需要加速服务正确回源并保留签名查询参数。" },
    ],
  },
  login: {
    title: "登录设置",
    description: "配置管理端 SSO 单点登录（OIDC）。未配置 Issuer 时仅允许邮箱密码登录；控制台的「重置登录密码」在同一页面维护。",
    fields: [
      { key: "oidc_issuer", label: "OIDC Issuer", type: "text", help: "SSO 可选；清除数据库覆盖后仍会回退环境变量。" },
      { key: "oidc_client_id", label: "OIDC Client ID", type: "text" },
      { key: "oidc_client_secret", label: "OIDC Client Secret", type: "secret" },
    ],
  },
  security: {
    title: "安全设置",
    description: "配置管理端会话与播放签名。主密钥 MK 和数据库连接始终由部署环境提供，不在此编辑。",
    fields: [
      { key: "admin_base_url", label: "管理端公开地址", type: "text", help: "CNB 预览环境的基址由平台覆盖。" },
      { key: "admin_trusted_origins", label: "管理端信任来源", type: "text", help: "逗号分隔的 http(s) 来源或域名；支持 *.example.com。" },
      ttl("admin_session_ttl_sec", "管理端会话有效期（秒）"),
      { key: "url_sign_key_kid", label: "播放签名密钥 ID", type: "text" },
      { key: "url_sign_key_hex", label: "播放 URL 签名密钥", type: "secret", help: "64 位十六进制（32 字节）。更换后，旧密钥签发的播放链接将失效。" },
      { key: "better_auth_secret", label: "管理端会话密钥", type: "secret", help: "至少 32 字符。更换后，管理员可能需要重新登录。" },
    ],
  },
  worker: {
    title: "任务设置",
    description: "调整 Worker 运行模式、轮询、任务租约和最大尝试次数；转码编码参数在「转码模板」维护。",
    fields: [
      { key: "worker_mode", label: "Worker 运行模式", type: "text", placeholder: "resident", help: "resident = 常驻轮询（自托管）；http = HTTP 门铃（serverless，需配置唤醒地址与密钥）。ADR-0017。" },
      { key: "worker_notify_url", label: "Worker 唤醒地址", type: "text", placeholder: "https://worker.example.com", help: "http 模式必填；发起转码 / 重启后管理端会 POST 该地址（/wake）加速认领。通知可丢，任务留存队列。" },
      { key: "worker_notify_secret", label: "Worker 唤醒密钥", type: "secret", help: "至少 16 字符；worker 侧 WORKER_NOTIFY_SECRET 需与之相同，不回显。" },
      { key: "worker_poll_interval_ms", label: "轮询间隔（毫秒）", type: "number", min: 500, max: 600000, help: "仅 resident 模式使用。" },
      { key: "worker_lease_ms", label: "任务租约（毫秒）", type: "number", min: 5000, max: 3600000, help: "执行中的任务继续按认领时的租约续期；新值作用于之后认领的任务。" },
      { key: "worker_max_attempts", label: "最大尝试次数", type: "number", min: 1, max: 20, help: "包含首次执行，不是额外重试次数。" },
      { key: "media_id_length", label: "新媒资 ID 位数", type: "number", min: MEDIA_ID_CONFIG.minLength, max: MEDIA_ID_CONFIG.maxLength, help: "只影响新上传媒资，已有 ID 和文件名保持不变。" },
    ],
  },
} satisfies Record<string, { title: string; description: string; fields: SettingField[] }>;

export type SettingsGroup = keyof typeof SETTINGS_GROUPS;
export interface SettingsEditorResponse {
  group: SettingsGroup;
  revision: string;
  fields: Array<{ key: string; label: string; value: string | null; source: "db" | "env" | "default"; secret: boolean; configured: boolean; overridden: boolean }>;
  restart_required: string[];
}
