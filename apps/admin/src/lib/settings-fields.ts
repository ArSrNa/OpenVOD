import { MEDIA_ID_CONFIG, SETTING_TTL_LIMITS } from "@openvod/shared";

export interface SettingField {
  key: string;
  label: string;
  type: "text" | "number" | "secret" | "boolean" | "enum";
  /** 只写作用或会导致失败的硬限制，不写功能说明与实现细节（AGENTS.md 最强约束） */
  help?: string;
  min?: number;
  max?: number;
  placeholder?: string;
  /** type="enum" 时的可选项；后端 enumValidator 校验同一取值集合 */
  options?: Array<{ value: string; label: string }>;
}
const ttl = (key: keyof typeof SETTING_TTL_LIMITS, label: string, help: string): SettingField => ({ key, label, type: "number", ...SETTING_TTL_LIMITS[key], help });

export const SETTINGS_GROUPS = {
  playback: {
    title: "播放设置",
    fields: [
      { key: "playback_base_url", label: "分发端公开地址", type: "text", placeholder: "https://delivery.example.com", help: "播放视频时请求的 API 地址" },
      ttl("jwt_ttl_sec", "播放端 JWT 有效期（秒）", "登录后能播放多久，到期需重新登录"),
      ttl("playback_session_ttl_sec", "播放会话有效期（秒）", "一次播放会话的有效期，过期后链接立即失效"),
      ttl("playback_manifest_ttl_sec", "清单签名有效期（秒）", "清单与分片链接的有效期，不能超过播放会话有效期"),
      ttl("playback_subtitle_ttl_sec", "字幕签名有效期（秒）", "字幕链接的有效期"),
      ttl("playback_subtitle_cache_max_age_sec", "字幕缓存时长（秒）", "0 表示不缓存；缓存期内改了字幕可能仍是旧内容"),
      { key: "cors_origins", label: "播放端跨域来源", type: "text", help: "允许哪些站点调用分发端接口；填 * 表示不限制" },
      { key: "delivery_preview_username", label: "控制台预览账号", type: "text", help: "管理端播放预览用的播放端账号" },
      { key: "delivery_preview_password", label: "预览账号口令", type: "secret", help: "留空表示不修改" },
    ],
  },
  storage: {
    title: "存储设置",
    fields: [
      { key: "s3_endpoint", label: "存储端点（Endpoint）", type: "text", placeholder: "https://cos.ap-shanghai.myqcloud.com", help: "视频文件存放的存储服务地址" },
      { key: "s3_endpoint_internal", label: "S3 内网端点（可选）", type: "text", placeholder: "https://cos-internal.ap-guangzhou.myqcloud.com", help: "同一存储桶的内网地址；留空用上面的端点" },
      { key: "s3_region", label: "存储地域（Region）", type: "text", placeholder: "ap-shanghai", help: "存储桶所在区域" },
      { key: "s3_bucket", label: "存储桶（Bucket）", type: "text", help: "存放视频文件的桶名，必须是私有桶" },
      { key: "s3_access_key_id", label: "Access Key ID", type: "text", help: "访问存储的账号 ID" },
      { key: "s3_secret_access_key", label: "Secret Access Key", type: "secret", help: "访问存储的密钥；留空表示不修改" },
      { key: "s3_force_path_style", label: "Path-style 寻址", type: "boolean", help: "桶名放路径还是放域名前；MinIO 一般开启，配错连不上存储" },
      { key: "storage_root_prefix", label: "资产根前缀", type: "text", placeholder: "openvod", help: "文件在桶内的存放目录；不能含 .. 或反斜线" },
    ],
  },
  delivery: {
    title: "分发设置",
    fields: [
      {
        key: "storage_sign_mode", label: "资产 URL 签名方式", type: "enum",
        options: [
          { value: "s3_presign", label: "S3 预签名（每个链接都不同，CDN 基本不命中缓存）" },
          { value: "cdn_url_auth", label: "CDN 鉴权（有效期内链接不变，可缓存）" },
          { value: "custom", label: "自定义（需自行实现并重新部署）" },
        ],
        help: "决定获取链接签名的方式；建议用 CDN 鉴权，避免缓存无法刷新",
      },
      { key: "storage_cdn_base_url", label: "存储加速域名", type: "text", placeholder: "https://cdn.example.com", help: "资源链接使用的加速域名" },
      {
        key: "storage_cdn_auth_type", label: "CDN 鉴权方式", type: "enum",
        options: [
          { value: "a", label: "方式 A（?sign=时间戳-随机数-uid-md5）" },
          { value: "b", label: "方式 B（路径带时间戳与 md5，按 UTC+8 分钟）" },
          { value: "c", label: "方式 C（路径带 md5 与十六进制时间戳）" },
          { value: "d", label: "方式 D（?token=md5&t=时间戳）" },
          { value: "v", label: "方式 V（?t=过期时间戳&sign=sha1）" },
        ],
        help: "必须与 CDN 控制台所选方式一致，否则链接全部被拒",
      },
      { key: "storage_cdn_auth_param", label: "鉴权参数名（方式 A）", type: "text", placeholder: "sign", help: "要和 CDN 控制台一致，1–100 位字母、数字或下划线" },
      { key: "storage_cdn_auth_token_param", label: "签名参数名（方式 D）", type: "text", placeholder: "token", help: "不能与时间戳参数名相同" },
      { key: "storage_cdn_auth_time_param", label: "时间戳参数名（方式 D）", type: "text", placeholder: "t", help: "方式 D 的时间戳参数名" },
      { key: "storage_cdn_auth_key", label: "CDN 边缘鉴权密钥", type: "secret", help: "要和 CDN 控制台的「Token 鉴权密钥」一致；留空表示不修改" },
      { key: "storage_cdn_auth_ttl_sec", label: "CDN 鉴权有效期（秒）", type: "number", min: 60, max: 604800, help: "要和 CDN 控制台的「有效时长」一致" },
      { key: "storage_custom_signer", label: "自定义提供者名", type: "text", placeholder: "custom", help: "代码里注册的签名器名字，对不上会报错" },
    ],
  },
  login: {
    title: "登录设置",
    fields: [
      { key: "oidc_issuer", label: "OIDC Issuer", type: "text", help: "留空只用邮箱密码登录" },
      { key: "oidc_client_id", label: "OIDC Client ID", type: "text", help: "SSO 应用在身份提供方那边的 Client ID" },
      { key: "oidc_client_secret", label: "OIDC Client Secret", type: "secret", help: "留空表示不修改" },
    ],
  },
  security: {
    title: "安全设置",
    fields: [
      { key: "admin_base_url", label: "管理端公开地址", type: "text", help: "管理端对外访问的地址，用于登录跳转和来源校验" },
      { key: "admin_trusted_origins", label: "管理端信任来源", type: "text", help: "允许登录和提交设置的来源，逗号分隔，支持 *.example.com" },
      ttl("admin_session_ttl_sec", "管理端会话有效期（秒）", "空闲多久后需要重新登录"),
      { key: "url_sign_key_kid", label: "播放签名密钥 ID", type: "text", help: "签名密钥的版本标识；改了已发出的播放链接会失效" },
      { key: "url_sign_key_hex", label: "播放 URL 签名密钥", type: "secret", help: "64 位十六进制（openssl rand -hex 32）；换了旧链接全部失效" },
      { key: "better_auth_secret", label: "管理端会话密钥", type: "secret", help: "至少 32 字符；换了所有管理员需重新登录" },
    ],
  },
  worker: {
    title: "任务设置",
    fields: [
      {
        key: "worker_mode", label: "Worker 运行模式", type: "enum",
        options: [
          { value: "resident", label: "常驻轮询（定时轮询数据库接任务）" },
          { value: "http", label: "HTTP 唤醒（收到 HTTP 请求才接任务）" },
          { value: "invoked", label: "异步函数（只跑请求里指定的任务，需挂载文件系统）" },
        ],
      },
      { key: "worker_notify_url", label: "Worker 唤醒地址", type: "text", placeholder: "https://worker.example.com", help: "HTTP 模式下用这个地址唤醒 Worker" },
      { key: "worker_notify_secret", label: "Worker 唤醒密钥", type: "secret", help: "至少 16 字符，要和 Worker 的 WORKER_NOTIFY_SECRET 一致" },
      { key: "worker_poll_interval_ms", label: "轮询间隔（毫秒）", type: "number", min: 500, max: 600000, help: "多久查一次新任务" },
      { key: "worker_lease_ms", label: "任务租约（毫秒）", type: "number", min: 5000, max: 3600000, help: "任务被认领后的锁定时间；只影响之后认领的任务" },
      { key: "worker_max_attempts", label: "最大尝试次数", type: "number", min: 1, max: 20, help: "一个任务最多执行几次，含第一次" },
      { key: "media_id_length", label: "媒资 ID 长度", type: "number", min: MEDIA_ID_CONFIG.minLength, max: MEDIA_ID_CONFIG.maxLength, help: "只影响之后上传的媒资，已有 ID 不变" },
    ],
  },
} satisfies Record<string, { title: string; fields: SettingField[] }>;

export type SettingsGroup = keyof typeof SETTINGS_GROUPS;
export interface SettingsEditorResponse {
  group: SettingsGroup;
  revision: string;
  fields: Array<{ key: string; label: string; value: string | null; source: "db" | "env" | "default"; secret: boolean; configured: boolean; overridden: boolean }>;
  restart_required: string[];
}
