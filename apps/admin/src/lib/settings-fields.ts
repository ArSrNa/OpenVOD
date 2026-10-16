import { MEDIA_ID_CONFIG, SETTING_TTL_LIMITS } from "@openvod/shared";

export interface SettingField {
  key: string;
  label: string;
  type: "text" | "number" | "secret" | "boolean" | "enum";
  help?: string;
  min?: number;
  max?: number;
  placeholder?: string;
  /** type="enum" 时的可选项；后端 enumValidator 校验同一取值集合 */
  options?: Array<{ value: string; label: string }>;
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
      {
        key: "storage_sign_mode", label: "资产 URL 签名方式", type: "enum",
        options: [
          { value: "s3_presign", label: "S3 预签名（默认；CDN 透传回源）" },
          { value: "cdn_url_auth", label: "CDN URL 鉴权（EO TypeA；CDN 私有回源）" },
          { value: "custom", label: "自定义提供者（需自行实现并重新构建）" },
        ],
        help: "桶恒为私有，切换的只是签名位置。s3_presign：CDN 缓存键必须含完整 query 或带 query 不缓存；cdn_url_auth：URL 在签名窗口内稳定、跨会话可命中缓存，需在 CDN 控制台配置私有回源（切换前请读部署文档 ADR-0019 清单）。",
      },
      { key: "storage_cdn_base_url", label: "存储加速域名", type: "text", placeholder: "https://cdn.example.com", help: "s3_presign：替换预签名对象 URL 的来源（需回源并保留签名 query）；cdn_url_auth：签名 URL 的加速域名。" },
      {
        key: "storage_cdn_auth_type", label: "CDN 鉴权方式", type: "enum",
        options: [
          { value: "a", label: "方式 A（?sign=timestamp-rand-uid-md5，默认）" },
          { value: "b", label: "方式 B（/{时间戳}/{md5}/路径；UTC+8 分钟）" },
          { value: "c", label: "方式 C（/{md5}/{时间戳}/路径；十六进制时间戳）" },
          { value: "d", label: "方式 D（?token=md5&t=timestamp）" },
          { value: "v", label: "方式 V（?t=过期时间戳&sign=sha1；视频场景增强）" },
        ],
        help: "与 CDN 控制台 Token 鉴权的「鉴权方式」一致（EO 官方 5 种）。A/B/C/D 的时间戳为签发时刻（URL 有效期 = 「CDN 鉴权有效期」）；V 的 t 为过期时刻（URL 有效期 1–2 个窗口，另加 EO 300 秒容差）。",
      },
      { key: "storage_cdn_auth_key", label: "CDN 边缘鉴权密钥", type: "secret", help: "cdn_url_auth 模式必填；与 CDN 控制台 Token 鉴权密钥同款、双侧一致。经主密钥封装保存，不回显。" },
      { key: "storage_cdn_auth_ttl_sec", label: "CDN 鉴权有效期（秒）", type: "number", min: 60, max: 604800, help: "cdn_url_auth 的签名窗口；应与 CDN 控制台「有效时长」一致。窗口内 URL 稳定（缓存友好），实际有效期 ≥ 该值。" },
      { key: "storage_custom_signer", label: "自定义提供者名", type: "text", placeholder: "custom", help: "sign_mode=custom 时生效；对应代码中 registerUrlSigner / RegisterURLSigner 的注册名（默认 custom）。" },
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
      {
        key: "worker_mode", label: "Worker 运行模式", type: "enum",
        options: [
          { value: "resident", label: "常驻轮询（适用于服务器）" },
          { value: "http", label: "HTTP发起（适用于serverless）" },
        ],
        help: "常驻轮询适用于服务器24小时在线环境，会不断触发轮询来接受任务。http则适用于突发环境，收到请求后触发任务。",
      },
      { key: "worker_notify_url", label: "Worker 唤醒地址", type: "text", placeholder: "https://worker.example.com", help: "http 模式必填；发起转码相关任务后会POST此地址" },
      { key: "worker_notify_secret", label: "Worker 唤醒密钥", type: "secret", help: "至少16字符；worker侧WORKER_NOTIFY_SECRET需与之相同" },
      { key: "worker_poll_interval_ms", label: "轮询间隔（毫秒）", type: "number", min: 500, max: 600000, help: "仅 常驻轮询模式使用。" },
      { key: "worker_lease_ms", label: "任务租约（毫秒）", type: "number", min: 5000, max: 3600000, help: "执行中的任务继续按认领时的租约续期；新值作用于之后认领的任务。" },
      { key: "worker_max_attempts", label: "最大尝试次数", type: "number", min: 1, max: 20, help: "包含首次执行，非额外重试次数。" },
      { key: "media_id_length", label: "媒资ID长度", type: "number", min: MEDIA_ID_CONFIG.minLength, max: MEDIA_ID_CONFIG.maxLength, help: "只影响新上传媒资，已有ID和文件名保持不变。" },
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
