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
const ttl = (key: keyof typeof SETTING_TTL_LIMITS, label: string, help?: string): SettingField => ({ key, label, type: "number", ...SETTING_TTL_LIMITS[key], help });

export const SETTINGS_GROUPS = {
  playback: {
    title: "播放设置",
    description: "决定播放链接用哪个域名、各类链接能用多久，以及管理端做播放预览时用哪个播放端账号。",
    fields: [
      { key: "playback_base_url", label: "分发端公开地址", type: "text", placeholder: "https://delivery.example.com", help: "播放清单、密钥、字幕的链接都基于这个地址生成，必须填播放器能访问到的分发端域名。留空会先用环境变量 DELIVERY_PUBLIC_BASE_URL；那里也没有就退回 http://127.0.0.1:<监听端口>，只适合本地调试。" },
      ttl("jwt_ttl_sec", "播放端 JWT 有效期（秒）", "播放端用户登录一次后，拿到的令牌能用多久。到期需要重新登录，v1 没有自动续期。"),
      ttl("playback_session_ttl_sec", "播放会话有效期（秒）", "一次播放会话能用多久。播放清单、密钥、字幕链接都挂在会话上，会话过期或被吊销后这些链接立即失效（吊销约 60 秒内生效）。"),
      ttl("playback_manifest_ttl_sec", "清单签名有效期（秒）", "播放清单链接和分片直链能用多久，也决定对象存储预签名链接的有效期。最长 7 天，并且不能超过「播放会话有效期」。"),
      ttl("playback_subtitle_ttl_sec", "字幕签名有效期（秒）", "字幕链接能用多久，实际取值不会超过播放会话的剩余时间。"),
      { key: "cors_origins", label: "播放端跨域来源", type: "text", help: "允许哪些站点在浏览器里直接调用分发端接口（管理端播放预览需要）。填 * 表示不限制；也可以填逗号分隔的完整来源，如 https://app.example.com，不要带路径。播放鉴权不走 Cookie，放开 * 不会带出登录态。" },
      { key: "delivery_preview_username", label: "控制台预览账号", type: "text", help: "管理端做播放预览时使用的播放端账号，必须是「播放端用户」里已经建好的用户。" },
      { key: "delivery_preview_password", label: "预览账号口令", type: "secret", help: "上面那个账号的口令。保存后不再显示，留空表示不修改。" },
    ],
  },
  storage: {
    title: "存储设置",
    description: "配置视频文件存放在哪里（S3 兼容存储，如腾讯云 COS、MinIO）。换桶或改根前缀不会搬动已有文件，已有媒资可能暂时打不开。CDN 加速和资源 URL 签名在「分发设置」里配。",
    fields: [
      { key: "s3_endpoint", label: "存储端点（Endpoint）", type: "text", placeholder: "https://cos.ap-shanghai.myqcloud.com", help: "对象存储的服务地址。腾讯云 COS 形如 https://cos.ap-shanghai.myqcloud.com，MinIO 形如 http://127.0.0.1:9000。" },
      {
        key: "s3_endpoint_internal",
        label: "S3 内网端点（可选）",
        type: "text",
        placeholder: "https://cos-internal.ap-guangzhou.myqcloud.com",
        help: "指向同一个桶的内网地址，只有转码 Worker 取源片、水印图时使用（播放端和管理端不走这里）。腾讯云环境填 COS 内网端点，自托管填 http://127.0.0.1:<端口>。留空则用上面的主端点，Worker 会实测各条通路并挑最快的一条。",
      },
      { key: "s3_region", label: "存储地域（Region）", type: "text", placeholder: "ap-shanghai", help: "桶所在的区域，和云控制台里的地域标识一致，如 ap-shanghai。" },
      { key: "s3_bucket", label: "存储桶（Bucket）", type: "text", help: "存放视频文件的桶名。桶必须是私有的，播放走签名链接。" },
      { key: "s3_access_key_id", label: "Access Key ID", type: "text", help: "访问存储用的账号 ID。" },
      { key: "s3_secret_access_key", label: "Secret Access Key", type: "secret", help: "访问存储用的密钥。会用主密钥加密后存库，不会返回给浏览器。" },
      { key: "s3_force_path_style", label: "Path-style 寻址", type: "boolean", help: "访问桶时把桶名放在路径里（http://端点/桶名），而不是放在域名前（http://桶名.端点）。MinIO 一般开启；COS 按实际访问方式配置，配错会连不上。" },
      { key: "storage_root_prefix", label: "资产根前缀", type: "text", placeholder: "openvod", help: "所有文件在桶内的存放目录，例如 openvod。可以留空表示放在桶根；不能包含 .. 或反斜线。" },
    ],
  },
  delivery: {
    title: "分发设置",
    description: "决定分片、封面等资源链接怎么签名：在服务器用 S3 预签名，还是交给 CDN 边缘做 URL 鉴权。存储桶始终是私有的；CDN 控制台侧的私有回源和 Token 鉴权属于部署配置，逐项清单见部署文档 deploy-delivery.md。",
    fields: [
      {
        key: "storage_sign_mode", label: "资产 URL 签名方式", type: "enum",
        options: [
          { value: "s3_presign", label: "S3 预签名（默认；CDN 透传回源）" },
          { value: "cdn_url_auth", label: "CDN URL 鉴权（EO Token 鉴权；CDN 私有回源）" },
          { value: "custom", label: "自定义提供者（需自行实现并重新构建）" },
        ],
        help: "S3 预签名：分发端直接给对象存储签链接，配置最简单；但每个链接都带不同的签名参数，CDN 基本命中不了缓存。CDN URL 鉴权：签名改由 CDN 边缘校验，链接在有效期内不变，可以正常缓存，需要先在 CDN 控制台开启私有回源和 Token 鉴权。自定义提供者：自己实现签名算法并重新部署，见下方提示词。",
      },
      { key: "storage_cdn_base_url", label: "存储加速域名", type: "text", placeholder: "https://cdn.example.com", help: "资源链接使用的加速域名。S3 预签名模式下只替换链接的域名，CDN 必须回源到存储并保留签名参数；CDN URL 鉴权模式下，这就是签名链接本身的域名。" },
      {
        key: "storage_cdn_auth_type", label: "CDN 鉴权方式", type: "enum",
        options: [
          { value: "a", label: "方式 A（?sign=timestamp-rand-uid-md5，默认）" },
          { value: "b", label: "方式 B（/{时间戳}/{md5}/路径；UTC+8 分钟）" },
          { value: "c", label: "方式 C（/{md5}/{时间戳}/路径；十六进制时间戳）" },
          { value: "d", label: "方式 D（?token=md5&t=timestamp）" },
          { value: "v", label: "方式 V（?t=过期时间戳&sign=sha1；视频场景增强）" },
        ],
        help: "必须和 CDN 控制台 Token 鉴权里选的「鉴权方式」一致（EO 官方共 5 种）。A/B/C/D 里带的是签发时刻，URL 有效时长 = 「CDN 鉴权有效期」；V 里带的是过期时刻，URL 有效期约为 1–2 个窗口，另外平台还有 300 秒容差。",
      },
      { key: "storage_cdn_auth_param", label: "鉴权参数名（方式 A）", type: "text", placeholder: "sign", help: "只在方式 A 生效：签名放在哪个 query 参数里。要和 CDN 控制台「鉴权加密串参数名称」一致，1–100 位字母、数字或下划线，默认 sign。" },
      { key: "storage_cdn_auth_token_param", label: "签名参数名（方式 D）", type: "text", placeholder: "token", help: "只在方式 D 生效：签名放在哪个 query 参数里，默认 token。可以和 CDN 控制台的自定义值保持一致，但不能和时间戳参数名相同。" },
      { key: "storage_cdn_auth_time_param", label: "时间戳参数名（方式 D）", type: "text", placeholder: "t", help: "只在方式 D 生效：时间戳放在哪个 query 参数里，默认 t。" },
      { key: "storage_cdn_auth_key", label: "CDN 边缘鉴权密钥", type: "secret", help: "CDN URL 鉴权模式下必填，值要和 CDN 控制台的「Token 鉴权密钥」完全一致。会用主密钥加密后存库，不回显。" },
      { key: "storage_cdn_auth_ttl_sec", label: "CDN 鉴权有效期（秒）", type: "number", min: 60, max: 604800, help: "签名窗口的长度，要和 CDN 控制台「有效时长」一致。窗口内同一资源的链接保持不变，能命中 CDN 缓存；实际可用时间不短于这个值。" },
      { key: "storage_custom_signer", label: "自定义提供者名", type: "text", placeholder: "custom", help: "只在签名方式选「自定义提供者」时生效：对应代码里 registerUrlSigner / RegisterURLSigner 注册的名字，默认 custom。" },
    ],
  },
  login: {
    title: "登录设置",
    description: "配置管理端的 SSO 单点登录（OIDC）。不填 Issuer 就只用邮箱密码登录；管理员自己的登录密码在页面下方的卡片里改。",
    fields: [
      { key: "oidc_issuer", label: "OIDC Issuer", type: "text", help: "SSO 提供方的 Issuer 地址（OIDC 标准字段），一般形如 https://id.example.com。留空表示关闭 SSO；清空这里的值后会回退到环境变量。" },
      { key: "oidc_client_id", label: "OIDC Client ID", type: "text", help: "SSO 应用在身份提供方那边的 Client ID。" },
      { key: "oidc_client_secret", label: "OIDC Client Secret", type: "secret", help: "SSO 应用的 Client Secret。会用主密钥加密后存库，不回显。" },
    ],
  },
  security: {
    title: "安全设置",
    description: "配置管理端登录会话和播放链接的签名密钥。主密钥（MASTER_KEYS）和数据库连接只能由部署环境提供，不能在页面里改。",
    fields: [
      { key: "admin_base_url", label: "管理端公开地址", type: "text", help: "管理端对外访问的地址，用于登录跳转和来源校验。CNB 预览环境会由平台覆盖。" },
      { key: "admin_trusted_origins", label: "管理端信任来源", type: "text", help: "允许登录和提交设置的来源，逗号分隔；可以写完整 http(s) 来源或域名，支持 *.example.com 通配。" },
      ttl("admin_session_ttl_sec", "管理端会话有效期（秒）", "管理员多久不操作会被登出。页面在使用中会不断续期，连续空闲超过这个时长才需要重新登录。"),
      { key: "url_sign_key_kid", label: "播放签名密钥 ID", type: "text", help: "签名密钥的版本标识，会写进每个播放链接的令牌；分发端按这个值找对应密钥。改了它，已签发的播放链接会因 kid 对不上而失效。没有多套密钥时保持默认 urlsign-v1 即可。" },
      { key: "url_sign_key_hex", label: "播放 URL 签名密钥", type: "secret", help: "给播放清单、分片、密钥、字幕链接签名的密钥，64 位十六进制（32 字节，可用 openssl rand -hex 32 生成）。换了之后，之前发出的播放链接全部失效。" },
      { key: "better_auth_secret", label: "管理端会话密钥", type: "secret", help: "管理端登录会话的加密密钥，至少 32 个字符。换了之后所有管理员需要重新登录。" },
    ],
  },
  worker: {
    title: "任务设置",
    description: "调整转码 Worker 怎么接任务、多久问一次、一次任务占用多久，以及失败后最多试几次。具体的编码参数在「转码模板」里配。",
    fields: [
      {
        key: "worker_mode", label: "Worker 运行模式", type: "enum",
        options: [
          { value: "resident", label: "常驻轮询（服务器常开）" },
          { value: "http", label: "HTTP 唤醒（Serverless 按需启动）" },
          { value: "invoked", label: "异步函数（按任务触发，不扫队列）" },
        ],
        help: "常驻轮询：Worker 一直在线，按间隔不断问数据库有没有新任务，适合自己有机房或服务器常开的情况。HTTP 发起：平时可以缩到零，管理端提交任务后再去唤醒 Worker，适合 serverless。异步函数：云函数收到唤醒请求后只执行请求里指定的任务，不扫描队列——要求平台支持异步执行且执行时长覆盖整个任务，实例需挂载文件系统（WORKER_JOBS_ROOT）。",
      },
      { key: "worker_notify_url", label: "Worker 唤醒地址", type: "text", placeholder: "https://worker.example.com", help: "HTTP 模式必填：发起转码等任务后，管理端会向这个地址发请求唤醒 Worker。" },
      { key: "worker_notify_secret", label: "Worker 唤醒密钥", type: "secret", help: "唤醒请求的签名密钥，至少 16 个字符，必须和 Worker 环境里的 WORKER_NOTIFY_SECRET 一致，否则唤醒会被拒绝。" },
      { key: "worker_poll_interval_ms", label: "轮询间隔（毫秒）", type: "number", min: 500, max: 600000, help: "只在常驻轮询模式下使用。间隔越小接任务越快，数据库压力也越大。" },
      { key: "worker_lease_ms", label: "任务租约（毫秒）", type: "number", min: 5000, max: 3600000, help: "任务被认领后锁定的时长，Worker 执行期间会自动续期。改这里只影响之后被认领的任务，正在跑的任务不受影响。" },
      { key: "worker_max_attempts", label: "最大尝试次数", type: "number", min: 1, max: 20, help: "一个任务最多执行几次，包含第一次，不是额外重试次数。超过就标记为失败。" },
      { key: "media_id_length", label: "媒资 ID 长度", type: "number", min: MEDIA_ID_CONFIG.minLength, max: MEDIA_ID_CONFIG.maxLength, help: "新上传媒资生成的 ID 长度。只影响之后上传的媒资，已有的 ID 和文件名不变。" },
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
