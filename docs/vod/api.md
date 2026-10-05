# OpenVOD HTTP API 参考

覆盖全部 HTTP 接口：**管理端（Control Plane，`apps/admin`，Next.js 全栈）** 与
**分发端（Data Plane，`apps/delivery`，Go 1.26 + Chi）**。

| 项 | 位置 |
|---|---|
| 契约真相源（DTO） | `packages/contracts/src/index.ts`（zod）→ JSON Schema → Go struct（`apps/delivery/internal/contracts/`，生成物入库，CI diff 门禁） |
| 跨端常量（错误码 / 存储键 / 上限） | `packages/shared/src/index.ts`（Go 侧手工对齐） |
| 功能规范 | [spec.md](./spec.md)：§2 管理端 / §5 转码 / §6 分发端 / §7 字幕 / §8 分类与自定义元数据 |
| 决策 | [decisions/](./decisions/)（ADR-0004 数据面、0006 加密播放、0007 鉴权、0010 分发端 API 面、0014 模板、0016 分类与自定义元数据） |
| 排错 | [dev-workflow.md](./dev-workflow.md)（§5 播放链路调试 / §8 排错速查） |

> 标记约定：🆕 = 2026-09-24 新增或变更（分类管理、媒资自定义元数据、分发端 `custom` 公开白名单）。
> 本文件按**实现**编写；与契约声明不一致处集中在 [§3.3 已知差异](#33-已知差异与未实现项)。

---

## 0. 通用约定

### 0.1 两个面、两套鉴权（勿混用）

| 面 | 基址 | 鉴权 | 载体 | 签发方 |
|---|---|---|---|---|
| 管理端 API | `http://<admin>/api/admin/*` | better-auth **DB 会话**（可吊销） | httpOnly Cookie | 管理端自身（登录页邮箱口令 / OIDC 双轨） |
| 管理端认证 API | `http://<admin>/api/auth/*` | — | — | better-auth 挂载点 |
| 分发端业务 API | `http://<delivery>/v1/auth/login`、`/v1/media*` | **ES256 JWT** | `Authorization: Bearer <token>` | 分发端（私钥存 `signing_keys`，MK 封装） |
| 分发端播放资源 | `/v1/media/{id}/manifest/*`、`/key`、`/subtitles/*.vtt` | **URL 签名 token**（HMAC-SHA256） | query `t`（Safari 原生 HLS 必须）或 header `X-Playback-Token` | 分发端（`play` 时一并下发） |

> Safari 原生 HLS 的分片与密钥请求无法自定义请求头，因此播放资源鉴权**必须**走 URL query 签名 token（ADR-0006）。

### 0.2 错误信封与错误码

所有 JSON 错误统一为：

```json
{ "error": { "code": "bad_request", "message": "字段路径: 具体原因" } }
```

`code` 取值（`packages/shared ERROR_CODES`，Go 侧 `internal/contracts/ErrorEnvelope.go` 对齐）：

`unauthorized` · `invalid_credentials` · `forbidden` · `bad_request` · `bad_token` · `not_found` ·
`not_playable` · `session_limit` · `rate_limited` · `not_implemented` · `internal`

约定：**409 冲突复用 `bad_request`**（管理端历史口径，消息说明原因）；分发端分别使用
`not_playable`（409，产物/状态不可播）与 `session_limit`（409，并发上限）。

### 0.3 其它通用纪律

- **缓存**：管理端 `apiJson` / `apiError` 一律附 `Cache-Control: no-store`；分发端 m3u8 / 密钥 / 字幕三类响应
  必须 `no-store`（P0 纪律，CI 门禁 `assert-unsigned-403` / `assert-no-store`）。JSON 响应（healthz / login / media / play）不设 `Cache-Control`。
- **请求体**：分发端 JSON body 上限 **64 KiB**；管理端设置写入上限 **64 KiB**；字幕文件 ≤ **5 MiB**。
- **时间**：ISO 8601 字符串（管理端 DTO 为 `toISOString()`；分发端 `expires_at` 为 RFC3339 UTC）。
- **CORS**：分发端由 `DELIVERY_CORS_ORIGINS`（默认 `*`，逗号分隔）控制；允许头
  `Content-Type, Authorization, X-Playback-Token, Range`，暴露头 `Content-Length, Content-Range, Accept-Ranges`；
  任意路径 `OPTIONS` → `204`。管理端 UI/API 同源，无 CORS。
- **分页**：分发端 `GET /v1/media` 的 `cursor` **未实现**（`next_cursor` 恒 `null`）；管理端列表接口不分页。

---

## 1. 管理端 API（Control Plane）

### 1.0 守卫与系统端点

| 端点 | 认证 | 说明 |
|---|---|---|
| `GET /healthz` | 无 | `200 {"ok":true,"db":<bool>}`（`db` 仅观测，不影响状态码） |
| `GET /api/setup` | 无 | 未初始化：`200 {setup_completed:false, master_keys_ok, master_keys_error, master_keys_hint, master_keys_versions, storage_configured}`；已完成：`403 forbidden`「系统已完成初始化」 |
| `POST /api/setup` | 无 | 首次启动向导：JSON body 必填 `s3_endpoint / s3_bucket / s3_access_key_id / s3_secret_access_key`，可选 `s3_region / s3_force_path_style / storage_root_prefix / storage_cdn_base_url / playback_base_url / admin_email / admin_password / admin_name`；返回 `200 {setup_completed:true, admin_error:null\|string}`；已完成再调用 → `403 forbidden` |
| `/api/auth/*` | — | better-auth 挂载点（`GET`/`POST`）。登录页用 `POST /api/auth/sign-in/email`（审计 `console.login` / 失败 `console.login_failed`）；`sign-up` 被显式拒绝（`FORBIDDEN`「管理端不开放注册」）；OIDC 走 `POST /api/auth/sign-in/social` + `GET /api/auth/callback/generic-oidc`；登录设置页用 `GET /api/auth/list-accounts`（探测本地密码账号）与 `POST /api/auth/change-password`（body `{currentPassword, newPassword, revokeOtherSessions:true}`，管理员自助重置密码、吊销其他会话）；`sign-out` / `get-session` 为 better-auth 默认路径 |
| `/api/admin/*`（未实现路径） | 会话 | `501 {error:{code:"not_implemented", ...}}`（catch-all 占位） |

**`/api/admin/*` 守卫**（`apps/admin/src/lib/api.ts getAdminSession`）：无 Cookie 会话 **或** 首次启动向导未完成
（`system_settings.setup_completed` 非 `1`）→ `401 {"error":{"code":"unauthorized","message":"未登录"}}`。
业务错误经各自的 `*ErrorResponse` 映射为 `apiError(code, message, status)`，未识别异常 → `500 internal`。

**审计**：写操作落 `audit_logs`（`actorType:"admin_user"`，IP 取 `x-forwarded-for` 首段 / `x-real-ip`），
审计写失败不阻断业务。动作名清单见 [§3.2](#32-审计动作名)。

---

### 1.1 媒资

| 端点 | 请求 | 成功响应 | 主要错误 |
|---|---|---|---|
| `GET /api/admin/media` | — | `200 {total, items[]}`；条目 = `{id, title\|null, status\|null, posterKey\|null, category\|null, description\|null, tags[], ext, key, size, lastModified?, uploadedAt\|null, assets{proceed,cover,metadata}, products[], subtitleCount}` 🆕（`category/description/tags/uploadedAt`） | `500` |
| `POST /api/admin/media/upload?filename=<name>&title=<可选展示名>` | **原始字节流**（`Content-Type` 任意，流式接收） | `201 {id, title, ext, key, size, metadata}` 🆕；**上传完毕后异步自动生成元数据**（2026-09-30）：响应**立即返回**、`metadata = {status:"pending"}`，探测在响应发送后由后台任务执行（Next `after()`：ffprobe → `metadata/{id}/probe.json` + `media.probe` / `duration_ms`）——best-effort，失败只告警（可手动 `POST /{id}/metadata` 重跑）；管理端以**递增间隔轮询详情**直至 `probe` 就绪（约 30s 上限） | `400` 空体 / 缺 `filename` / 无法识别扩展名；`500` 存储或 DB 失败（自动探测失败**不算**上传失败） |
| `GET /api/admin/media/{id}` | 路径 `id` 为纯数字 | `200` 详情：`{id, title, status, ext, size, lastModified, uploadedAt\|null, createdAt, updatedAt, durationMs, posterKey, sourceKey, probe, custom{category,description,tags}, customData, assets{...}, products[]}` 🆕（`uploadedAt`） | `400` ID 形状非法；`404` 媒资不存在 |
| `PATCH /api/admin/media/{id}` 🆕 | `UpdateMediaRequest`（见下） | `200` 按传入字段增量返回：`{id, title?, custom?, customData?, customDataKey?, customDataWritten?}` | `400` 校验失败 / 至少一字段；`404` 媒资未入库或分类不存在；`500` |
| `DELETE /api/admin/media/{id}` | — | `200 {removed: boolean}` | `400` ID 形状非法；`500` |
| `GET /api/admin/media/{id}/original` | — | `302` → 对象存储预签名 GET（TTL 600s，可经 `STORAGE_CDN_BASE_URL`）；响应 `no-store` | `404` 原始文件不存在 |
| `GET /api/admin/media/{id}/cover` | — | `302` → 预签名 GET（600s）；`no-store` | `404` 未设置封面 |
| `POST /api/admin/media/{id}/cover?filename=<name>` | **原始图片字节流**（jpg/png/webp/gif/avif） | `201 {key}` | `400` 空体 / 缺 filename / 非图片；`404` 媒资未入库；`500` |
| `POST /api/admin/media/{id}/metadata` | —（无 body） | `200 {id, probeKey, summary}`（ffprobe 摘要；`probeKey = metadata/{id}/probe.json`）；**上传完毕后由 upload 接口异步自动触发**（2026-09-30，响应后后台执行），此端点用于**手动重跑**（幂等覆盖） | `404` 媒资 / original 缺失；`500` 缺 ffprobe、预签名失败 |
| `POST /api/admin/media/{id}/preview-play` | `{template_id?: string}`（`""` = 显式旧布局；缺省 = 自动选择） | `200 {sid, manifest_url, expires_at, template_id, encrypted, browser_cors_ok}`（管理端以预览账号换分发端签名 URL，**不出密钥**） | `501` 未配置预览账号；`502` 分发端不可达；分发端错误码透传（404→404，其余→409） |
| `POST /api/admin/media/{id}/transcode` | `{template_ids: string[]}`（1..10，去重保序） | `202 {jobs:[{job_id, template_id, template_name, watermark_id\|null, status:"QUEUED"}]}` | `400` zod / 加密但非 HLS / `keep_original` 模板却关联水印 / 图片水印未上传图；`404` 媒资 / original / 模板 / 水印缺失；`409` 同媒资同模板已有未终结任务 |
| `DELETE /api/admin/media/{id}/products/{templateId}` | `templateId` = 模板 cuid 或字面量 `legacy` | `200 {deleted, bytes}` | `400` 形状非法；`404` 产物不存在；`409` 该模板有进行中任务 |

#### 🆕 `PATCH /api/admin/media/{id}`（重命名 + 自定义元数据 + 自定义上传时间）

请求（`contracts UpdateMediaRequest`，至少一个字段，否则 400）：

| 字段 | 类型 / 约束 | 语义 |
|---|---|---|
| `title` | `string`，trim 后 1..191 | **重命名**：只改 `media.title`，绝不动 `original` 文件名与媒资 ID（审计 `media.rename`） |
| `description` | `string \| null`，≤ 191（`MEDIA_DESCRIPTION_MAX`） | **视频（媒资）自身的描述**；`null` = 清空。与分类描述（`media_categories.description`，见 §1.2）完全独立 |
| `tags` | `string[] \| null`，≤ 20 张（`MEDIA_TAGS_MAX`）、每张 trim 后 1..32（`MEDIA_TAG_LENGTH_MAX`） | 业务标签；`null` / `[]` = 清空；服务端去首尾空白、按首现顺序去重 |
| `category_id` | `string \| null` | 归属分类；**`null` = 归入默认分类「其他」**；给具体 id 时分类必须存在（否则 404） |
| `uploaded_at` 🆕 | ISO 8601 字符串（`Z` / 带时区偏移）`\| null` | **自定义上传时间**（spec.md §3.1）；`null` = 恢复默认（回退存储对象原始写入时间）。影响管理端「上传时间」展示与分发端列表排序回退链，**不进入**自定义元数据投影 / 分发端下发（审计 `media.uploaded_at_update`） |

副作用（`description` / `tags` / `category_id` 任一命中，审计 `media.metadata_update`）：

1. 重算自定义元数据投影（保留白名单外扩展键）→ 写 `media.custom_data`；
2. best-effort 导出 `metadata/{id}/custom.json`（失败只在响应里 `customDataWritten=false`，**不回滚 DB**）。

请求 / 响应示例：

```http
PATCH /api/admin/media/55395830
Content-Type: application/json
Cookie: <better-auth session>

{ "category_id": "cmueca653000191r0p1l7vctq", "description": "演唱会 4K 母版", "tags": ["4K", "HDR"] }
```

```json
{
  "id": "55395830",
  "custom": {
    "category": { "id": "cmueca653000191r0p1l7vctq", "name": "HDR雷霆大闪光", "path": "音视频测试 / HDR雷霆大闪光" },
    "description": "演唱会 4K 母版",
    "tags": ["4K", "HDR"]
  },
  "customData": {
    "category": { "id": "cmueca653000191r0p1l7vctq", "name": "HDR雷霆大闪光", "path": "音视频测试 / HDR雷霆大闪光" },
    "description": "演唱会 4K 母版",
    "tags": ["4K", "HDR"]
  },
  "customDataKey": "metadata/55395830/custom.json",
  "customDataWritten": true
}
```

> 上传新媒资时即写入默认分类「其他」的投影（新媒资不留空，spec.md §8.1）；纯 `title` 请求不回传 `custom*` 字段。

---

### 1.2 🆕 分类（独立模块，无限层级）

| 端点 | 请求 | 成功响应 | 主要错误 |
|---|---|---|---|
| `GET /api/admin/categories` | — | `200 {total, items[]}`；条目 = `{id, name, description\|null, parent_id\|null, sort_order, is_system, media_count, descendant_media_count, created_at, updated_at}` | `500` |
| `POST /api/admin/categories` | `CreateMediaCategoryRequest` | `201 {item}` | `400` zod；`404` 上级分类不存在；`409` 同级重名 |
| `PATCH /api/admin/categories/{id}` | `UpdateMediaCategoryRequest`（partial，至少一字段） | `200 {item, refreshed_media}` | `400` zod；`404` 分类不存在 / 上级不存在；`409` 同级重名 / 环路 |
| `DELETE /api/admin/categories/{id}` | — | `200 {id, name, affected_media, moved_to, refreshed_media}` | `404` 分类不存在；`409` 系统默认分类 / 有子分类 |

字段语义：

| 字段 | 说明 |
|---|---|
| `name` | trim 后 1..64（`MEDIA_CATEGORY_NAME_MAX`）；**同一上级下唯一**（顶级也一样，顶级 `parent_id IS NULL` 的唯一性靠应用层） |
| `description` | ≤ 191（`MEDIA_CATEGORY_DESCRIPTION_MAX`）；`null` = 清空 |
| `parent_id` | 上级分类；缺省 / `null` = 顶级；**无限层级**；移动时禁止环路（不得挂到自身或自身子孙下 → 409） |
| `sort_order` | 同级排序，0..10000（越小越靠前） |
| `is_system` | **只读**：系统默认分类「其他」为 `true` → 不可删除；未知字段不接受 |
| `media_count` | **直属**媒资数（未设置分类的历史媒资计入「其他」） |
| `descendant_media_count` | 含子孙分类的媒资数（**保留字段**：当前管理端不展示，仅 API 返回） |
| `moved_to` | 删除响应字段：被迁出媒资的目标分类 id（系统默认分类「其他」） |

行为规则（spec.md §8.1，ADR-0016）：

- **系统默认分类「其他」** 由系统保证存在（MySQL 迁移插入；SQLite / 历史库运行时幂等补建），
  未设置分类的媒资默认归入它；**不可删除**，可改名 / 移动 / 排序。
- **改名 / 移动**会刷新受影响媒资（该分类子树 + 默认分类场景下的历史空值行）的 `custom_data` 投影，
  响应中的 `refreshed_media` 即刷新条数。
- **删除**不删媒资：该分类下的媒资先迁入「其他」，再删分类，并刷新其投影。

示例：

```http
POST /api/admin/categories
{ "name": "纪录片", "description": "非虚构内容", "parent_id": null, "sort_order": 10 }
→ 201 { "item": { "id": "cmu…", "name": "纪录片", "parent_id": null, "sort_order": 10, "is_system": false,
                  "media_count": 0, "descendant_media_count": 0, "created_at": "…", "updated_at": "…" } }
```

```http
PATCH /api/admin/categories/cmu…
{ "parent_id": "cmu…movie", "sort_order": 0 }        # 移动 + 同级排序
→ 200 { "item": { … }, "refreshed_media": 12 }        # 12 个媒资的 path 快照已同步
```

```http
DELETE /api/admin/categories/cother00000000000000000    # 默认分类
→ 409 { "error": { "code": "bad_request", "message": "「其他」是系统默认分类（未设置分类的媒资归属它），不可删除" } }
```

---

### 1.3 字幕（spec.md §7）

| 端点 | 请求 | 成功响应 | 主要错误 |
|---|---|---|---|
| `GET /api/admin/media/{id}/subtitles` | — | `200 {items[]}`；轨道 = `{id, lang, label, is_default, status, bytes, storage_key, storage_ok\|null, created_at, updated_at}` | `400` ID 形状；`404` 媒资未入库 |
| `POST /api/admin/media/{id}/subtitles?lang=<BCP-47>&label=<名>&is_default=<true\|1>` | **原始字幕字节流**（`.vtt` 或 `.srt`，SRT 自动转 VTT，≤5 MiB） | `201 {item}` | `400` 空体 / 语言标签非法 / VTT 校验失败；`409` 同媒资同语言；`404` 媒资未入库 |
| `PATCH /api/admin/media/{id}/subtitles/{trackId}` | `{label?, lang?, is_default?}`（至少一字段） | `200 {item}` | `400`；`409` 改语言撞轨；`404` 轨道不存在 |
| `DELETE /api/admin/media/{id}/subtitles/{trackId}` | — | `200 {removed: true, item}` | `404` |
| `GET /api/admin/media/{id}/subtitles/{trackId}/content` | — | `200` 原始字节，`Content-Type: text/vtt; charset=utf-8`，`no-store` | `404` 轨道 / 对象缺失 |
| `PUT /api/admin/media/{id}/subtitles/{trackId}/content` | **原始字幕字节流**（同校验管道） | `200 {item}`（就地覆盖同一对象，键不变） | `400` 校验失败；`404` |

语言按 BCP-47（输入兼容 `zh_CN` / `en_US`，服务端归一化）；首条轨道自动成为默认轨；`trackId` 为 cuid 形状。

---

### 1.4 转码模板（ADR-0014；水印关联见 spec.md §10 / ADR-0018）

| 端点 | 请求 | 成功响应 | 主要错误 |
|---|---|---|---|
| `GET /api/admin/templates` | — | `200 {total, items[]}`（`createdAt` 倒序）；模板 = `{id, name, description\|null, keep_original, encrypt, format:"HLS", params\|null, is_default, watermark_id\|null, created_at, updated_at}` | `500` |
| `POST /api/admin/templates` | `CreateTranscodeTemplateRequest` | `201 {item}` | `400` zod / 加密但非 HLS / `keep_original` 与 `watermark_id` 并存 / 图片水印未上传图；`404` 水印不存在；`409` 模板名已存在 |
| `GET /api/admin/templates/{id}` | — | `200 {item}` | `404` |
| `PATCH /api/admin/templates/{id}` | `UpdateTranscodeTemplateRequest`（partial，`watermark_id: null` = 解除关联） | `200 {item}` | `400` zod / 加密-格式非法 / 从「保持原视频」切回转码须同时给 `params` / 水印两层校验；`404`；`409` 重名 |
| `DELETE /api/admin/templates/{id}` | — | `200 {id}` | `404` |

`params`（`TranscodeTemplateParams`）：`codec: libx264|libx265`；`bitrate_kbps`(100..200000) 与 `crf`(0..51) **二选一**；
`fps?`(1..240)、`preset?`(ultrafast…veryslow)、`audio_bitrate_kbps`(32..320，默认 128)、
`resolutions`(1..10，`{mode:"fixed",width,height}` / `{mode:"adaptive",max_width?,max_height?}` /
`{mode:"source"}` 保持原分辨率——2026-10-05 增：恒取源尺寸、不缩放，是否执行由帧率 / 码率维度判定，spec.md §5.4)。
`keep_original=true`（只加密流程）时 `params` 落 `NULL`。

`watermark_id`（可选，spec.md §10.4）：关联一个水印模板，转码时由 Worker 烧录进每档画面；
`keep_original=true` 时恒为 `null`（`-c copy` 不解码，无法叠加画面）。两层校验：

- 模板保存（`templates.ts::assertWatermarkLink`）与任务发起（`transcode-submit.ts`）各校验一次；
- 拒绝条件一：`keep_original=true && watermark_id != null` → `400`；
- 拒绝条件二：指向图片型水印但 `image_key` 为空（未上传图）→ `400`。

submit 时水印内容快照进 `transcode_jobs.template_snapshot.watermark`，模板 / 图片后续变更不影响已入队任务。

---

### 1.4b 水印模板（spec.md §10 / ADR-0018）

| 端点 | 请求 | 成功响应 | 主要错误 |
|---|---|---|---|
| `GET /api/admin/watermarks` | — | `200 {total, items[]}`（`createdAt` 倒序）；条目 = `{id, name, description\|null, type, params, image_ext\|null, image_key\|null, image_bytes\|null, image_width\|null, image_height\|null, image_status:"ready"\|"missing", referenced_by, created_at, updated_at}` | `500` |
| `POST /api/admin/watermarks` | `CreateWatermarkRequest` | `201 {item}` | `400` zod（`params` 至少给宽或高 / 颜色 / 字号 / 偏移越界 / 含控制字符或单引号）；`409` 模板名已存在 |
| `GET /api/admin/watermarks/{id}` | — | `200 {item}`（+ `referenced_by`） | `404` |
| `PATCH /api/admin/watermarks/{id}` | `UpdateWatermarkRequest`（partial；`params.type` 不可改） | `200 {item}` | `400` zod / 改类型；`404`；`409` 重名 |
| `PUT /api/admin/watermarks/{id}/image` | **原始图片字节流**（`application/octet-stream`，≤ 2 MiB） | `200 {item}`（`image_*` 列由 ffprobe 探测回填；同键覆盖式 PUT，扩展名变化时删旧对象） | `400` 空体 / 超限 / 非 png·jpg·webp（**按内容识别**）/ 探测不出宽高 / 文字型无图片资产；`404` |
| `GET /api/admin/watermarks/{id}/image` | — | `302` → S3 预签名（`STORAGE_CDN_BASE_URL` 替换 origin） | `404` 文字型或图片未上传 |
| `DELETE /api/admin/watermarks/{id}` | — | `200 {id, removed_objects}` | `404`；`409` 正被 N 个转码模板引用（先解除关联；DB 侧 `SetNull` 兜底） |

`params`（`WatermarkParams`，按 `type` 判别联合，公共字段 `anchor`（九宫格 9 值）/ `offset_x`/`offset_y`（−4096..4096，默认 0）/ `opacity`（0..100，默认 100）/ `blend`（`normal` 默认 | `overlay`））：

- **图片**：`size` = `{mode:"pixels",width?,height?}`（1..7680；两项精确缩放，单项按 `image_width`/`image_height` 等比）或 `{mode:"percent",width?,height?}`（1..100，占画面宽/高百分比）；
- **文字**：`text`（1..64 字符，trim 后非空，不含控制字符与单引号 `'`，后者是 ffmpeg 约束）、`font`（`sans`/`sans_bold`/`serif`）、`color`（`#RRGGBB`）、`shadow`（`null` 或 `{color, offset_x −100..100, offset_y −100..100}`）、`size` = `{mode:"pixels",size}`（字号 4..512）或 `{mode:"percent",size}`（输出高度百分比 1..100）。

> 图片未上传（`image_status="missing"`）的模板**不可被转码模板关联**。删除水印模板不影响已产出内容；更新水印需重新转码才生效。

---

### 1.5 密钥（spec.md §4；**永不返回密钥材料**）

| 端点 | 请求 | 成功响应 | 主要错误 |
|---|---|---|---|
| `GET /api/admin/keys` | — | `200 {total, items[]}`；条目 = `{media_id, title\|null, media_status\|null, kid, method, mk_ver, created_at, proceed_objects\|null}` | `500`（`MASTER_KEYS` 缺失/非法同为 500） |
| `GET /api/admin/keys/{mediaId}` | `mediaId` 纯数字 | `200 {item}`（+ `iv`、`active_sessions`） | `400` ID 形状；`404` 该媒资无密钥 |
| `DELETE /api/admin/keys/{mediaId}` | — | `200 {media_id}` | `400`；`404`；`409` 存在未过期播放会话（先吊销） |
| `GET /api/admin/keys/mk` | — | `200 {active_ver, versions:[{ver,keys}], total_keys}`（仅版本与密钥数量，不回显密钥） | `500` |
| `POST /api/admin/keys/rotate-mk` | `{from_ver?: number}`（缺省 = 全部非 active 版本） | `200 {rotated, failed, to_ver, errors[{media_id,kid,message}]}` | `400` zod；`500` |

> 删除密钥后已加密分片**无法解密**（需重转码）；MK 轮换只重封装 `wrapped_cek`，**不动媒体字节**。

---

### 1.6 转码任务

| 端点 | 请求 | 成功响应 | 主要错误 |
|---|---|---|---|
| `GET /api/admin/jobs` | —（内部固定取 200 条） | `200 {total, items[]}`；任务 = `{id, media_id, media_title\|null, status, template_id\|null, template_name\|null, attempts, lease_active, last_error\|null, created_at, started_at\|null, finished_at\|null}`；`status ∈ QUEUED\|PROBING\|ENCODING\|PACKAGING\|DONE\|FAILED` | `500` |
| `GET /api/admin/jobs/stream` | —（SSE） | `200 text/event-stream`；头 `Cache-Control: no-store, no-transform`、`X-Accel-Buffering: no`；事件 `jobs`（全量快照，连上即回放）、`ping`（15s 保活）；**10 分钟主动断开**由 EventSource 重连 | `401`（JSON 信封，非 SSE 流） |
| `POST /api/admin/jobs/{id}/stop` | — | `200 {id, status:"FAILED"}`（写 `lastError`、清租约） | `404`；`409` 执行中且租约有效 |
| `POST /api/admin/jobs/{id}/restart` | — | `200 {id, status:"QUEUED"}`（`attempts=0`、清错误与租约） | `404`；`409` 不可重启 |

---

### 1.7 播放端用户（响应绝不含 `password_hash`）

| 端点 | 请求 | 成功响应 | 主要错误 |
|---|---|---|---|
| `GET /api/admin/users` | — | `200 {total, items[]}`；用户 = `{id, username, display_name\|null, status, max_concurrent_sessions, active_sessions, last_login_at\|null, created_at, updated_at}` | `500` |
| `POST /api/admin/users` | `{username(^[a-zA-Z0-9._-]{3,32}$), password(≥8 且 ≤72 字节), display_name?≤64, max_concurrent_sessions?(默认 0), status?(默认 ACTIVE)}` | `201 {item}` | `400`；`409` 用户名已存在 |
| `GET /api/admin/users/{id}` | — | `200 {item}` | `404` |
| `PATCH /api/admin/users/{id}` | `{display_name?, status?, max_concurrent_sessions?}`（至少一字段） | `200 {item, revoked_sessions}` | `400`；`404` |
| `DELETE /api/admin/users/{id}` | — | `200 {id, username, revoked_sessions}` | `404` |
| `POST /api/admin/users/{id}/password` | `{password}`（≥8、≤72 字节） | `200 {id, username, revoked_sessions}`（bcrypt cost 12 + 同步吊销会话） | `400`；`404` |
| `POST /api/admin/users/{id}/revoke-sessions` | — | `200 {id, username, revoked_sessions}`（分发端 ≤60s 收敛） | `404` |

`max_concurrent_sessions = 0` 表示不限；`ACTIVE → DISABLED` 会立即吊销该用户全部未过期播放会话。

---

### 1.8 统计与系统设置

| 端点 | 请求 | 成功响应 | 主要错误 |
|---|---|---|---|
| `GET /api/admin/stats` | — | `200 {media{total,ready,not_ingested}, jobs{active,queued,probing,encoding,packaging}, users{total,active,disabled}, storage{used_bytes}, subtitles{total,media_count}, products{total,media_count}, metadata{total,probe,custom,other}}` | `500` |
| `GET /api/admin/settings?group=<playback\|storage\|login\|security\|worker>` | — | `200 {group, revision, fields[{key,label,value\|null,source:"db"\|"env"\|"default",secret,configured,overridden}], restart_required[]}`（`secret` 字段 `value` 恒 `null`）；`group=playback` 另附兼容字段 `playback_base_url` / `env_public_base_url` | `400` 未知分组；`500` |
| `PUT /api/admin/settings` | `Content-Type: application/json`；`{group, revision, values{key:value}}`（≤64 KiB；兼容旧调用 `{playback_base_url}`） | `200` 同 GET 结构 | `400` 未知分组 / 缺 revision / 未登记键 / 无修改 / 约束不满足；`403` Origin 或 `sec-fetch-site: cross-site`；`409` revision 冲突；`413` / `415`；`500` |

分组字段：`playback`（`playback_base_url, jwt_ttl_sec, playback_session_ttl_sec, playback_manifest_ttl_sec,
playback_subtitle_ttl_sec, cors_origins, delivery_preview_username, delivery_preview_password`）、
`storage`（`s3_endpoint, s3_region, s3_bucket, s3_access_key_id, s3_secret_access_key, s3_force_path_style,
storage_root_prefix, storage_cdn_base_url`）、`login`（`oidc_issuer, oidc_client_id, oidc_client_secret`；
登录方式与「重置登录密码」UI 同页维护，密码走 better-auth `/api/auth/change-password`）、
`security`（`admin_base_url, admin_trusted_origins, admin_session_ttl_sec, url_sign_key_kid, url_sign_key_hex,
better_auth_secret`）、`worker`（`worker_poll_interval_ms, worker_lease_ms, worker_max_attempts, media_id_length`）。
敏感值经 MK 封装后入库；写入审计 `settings.update`（secret 值标记 `[redacted]`）。

---

## 2. 分发端 API（Data Plane）

基址：`http://<delivery>`（本地 `:9000`，`DELIVERY_LISTEN` 控制）。全部失败统一错误信封。

### 2.0 探活与登录

| 端点 | 鉴权 | 请求 | 成功响应 | 主要错误 |
|---|---|---|---|---|
| `GET /healthz` | 无 | — | `200 {"status":"ok","app":"delivery"}` | — |
| `POST /v1/auth/login` | 无 | `{username, password}` | `200 {access_token, token_type:"Bearer", expires_in, kid}`（`expires_in` = `DELIVERY_JWT_TTL_SEC`，默认 86400） | `400` body 非法/为空；`401 invalid_credentials`「用户名或密码错误」（用户不存在 / 密码错 / 已禁用统一提示）；`503` 未配置 JWT 签名密钥 |

```bash
TOKEN=$(curl -s -X POST $D/v1/auth/login -H 'content-type: application/json' \
  -d '{"username":"demo","password":"<密码>"}' | python3 -c 'import sys,json;print(json.load(sys.stdin)["access_token"])')
```

JWT 为 ES256（P-256）compact JWS，header `{alg,typ,kid}`，claims `{iss,sub,iat,exp,jti,kid}`；
`sub` = 播放端用户 id；无 refresh（v1）。

### 2.1 🆕 媒资（含自定义元数据）

统一鉴权：`Authorization: Bearer <JWT>`；缺失 / 格式错 / 验签失败 / 过期 → `401 unauthorized`「未登录或凭证无效」。

#### `GET /v1/media?limit=<n>`

`limit` 缺省 **50**，合法区间 1..200，非法或越界**静默回退 50**；仅返回 `status = 'READY'`，
排序 `COALESCE(published_at, uploaded_at, created_at) DESC, id DESC`（发布时间 → 自定义上传时间 → 入库时间）；
`cursor` 未实现（`next_cursor` 恒 `null`）。

```json
{
  "items": [
    {
      "id": "55395830",
      "title": "aXeTy1hCrd0A",
      "duration_ms": 252011,
      "poster_url": "https://<cdn>/cover/55395830/poster.jpg?X-Amz-…",
      "custom": {
        "category": { "id": "cmueca653000191r0p1l7vctq", "name": "HDR雷霆大闪光", "path": "音视频测试 / HDR雷霆大闪光" },
        "description": "演唱会 4K 母版",
        "tags": ["4K", "HDR"]
      }
    }
  ],
  "next_cursor": null
}
```

#### `GET /v1/media/{id}`

`200` → `{id, title, status, playable, duration_ms, poster_url, probe, subtitles[], custom}`；
`probe` 子字段 `{width, height, video_codec, audio_codec, bitrate_bps}`（未探测为 `null`）；
`subtitles[]` = `{id, lang, label, is_default}`（仅 `READY`，不含 URL）；`404 not_found`「媒资不存在」；
非 READY 仍返回详情（`playable: false`）。

实测响应（dev，省略 `poster_url`）：

```json
{
  "id": "55395830", "title": "aXeTy1hCrd0A", "status": "READY", "playable": true,
  "duration_ms": 252011,
  "probe": { "width": 2560, "height": 1080, "video_codec": "hevc", "audio_codec": "aac", "bitrate_bps": 1026703 },
  "subtitles": [],
  "custom": { "category": { "id": "cmueca653000191r0p1l7vctq", "name": "HDR雷霆大闪光", "path": "音视频测试 / HDR雷霆大闪光" } }
}
```

#### 🆕 `custom`：自定义元数据公开白名单（spec.md §8.4 / ADR-0016）

来源：管理端写入的 `media.custom_data` 投影（分类 / 描述 / 标签）。分发端**只下发白名单内的三个键**，
其余键（含内部扩展字段）一律丢弃；值为空则**该键不出现**；整体恒为对象（无内容为 `{}`，不是 `null`）。

| 键 | 类型 | 规则 |
|---|---|---|
| `category` | `{id, name, path}` | 三字段均 trim；**`id` 或 `path` 为空则整键丢弃**；`path` 为祖先路径快照（如 `电影 / 科幻`）；未设置分类时即默认分类「其他」 |
| `description` | `string` | trim 后非空才下发 |
| `tags` | `string[]` | 逐项 trim、丢弃空串、按首现顺序去重、上限 20 |

解析容错：列为 `NULL` / 空串 / 非法 JSON / 非对象 → `{}`，**播放链路不因元数据脏数据中断**。
实现：`apps/delivery/internal/server/custom.go`（键名与 `@openvod/shared MEDIA_CUSTOM_KEYS` 手工对齐，单测 `custom_test.go`）。

### 2.2 播放会话：`POST /v1/media/{id}/play`

| 项 | 内容 |
|---|---|
| 鉴权 | JWT（见 2.1） |
| 请求 body | **可选**（`Content-Length > 0` 才解析）：`{force_new?: bool, template_id?: string\|null}`；`template_id` 缺省/`null` = 自动选择，`""` = 显式请求旧布局产物（`proceed/{id}/`），非空必须是模板 cuid |
| 成功 | `200 {sid, manifest_url, expires_at, template_id, subtitles[{id,lang,label,is_default,url}]}`；`sid` = `ps_` + 24 hex；`manifest_url` 已带 `typ=m` 签名 token 与 `tpl`；字幕 `url` 带 `typ=v` 签名 token（同一枚 token 覆盖全部轨道） |
| 幂等 | 非 `force_new` 时先复用同用户同媒资的未过期未吊销会话 |
| 并发上限 | 新建会话前检查 `users.max_concurrent_sessions`（0 = 不限），超限 → `409 session_limit` |
| 失败 | `400` body 非法；`404` 媒资不存在；`409 not_playable`（非 READY / 无产物 / 同名多产物未指定模板 / 指定模板无产物）；`409 session_limit`；`500` |

```bash
MF=$(curl -s -X POST $D/v1/media/<媒资id>/play -H "authorization: Bearer $TOKEN" -d '{}' \
  | python3 -c 'import sys,json;print(json.load(sys.stdin)["manifest_url"])')
```

### 2.3 播放资源（URL 签名 token）

签名 token：`b64url(JSON{ver,typ,mid,sid,exp,kid}) + "." + b64url(HMAC-SHA256)`，`ver=1`；
`typ ∈ {m 清单, s 分片, k 密钥, v 字幕}`（v1 中分片走 S3 预签名直出，`typ=s` 已定义未使用）。
传递：query `t` 优先，其次 header `X-Playback-Token`。

**通用失败**：缺 token / 格式非法 / kid 未知 / 验签失败 / 过期 / `typ` 不符 / `mid` 不符 →
`403 bad_token`；会话已过期或吊销 → `403 bad_token`「播放会话已过期或被吊销」；会话查询 DB 错误 → `500`。
`tpl` 参数（清单路由）：空 = 旧布局；非空须匹配 `^c[a-z0-9]{20,}$`，否则 `400 bad_request`。

| 端点 | 鉴权 | 响应 | 失败 |
|---|---|---|---|
| `GET /v1/media/{id}/manifest/master.m3u8?t=<m>&tpl=<可选>` | token `m` | `200` 改写后主清单文本，`Content-Type: application/vnd.apple.mpegurl; charset=utf-8`，`Cache-Control: no-store`；VARIANT 行 URI → `{PUBLIC_BASE_URL}/v1/media/{id}/manifest/<相对路径>?t=<新 m token>&tpl=…` | `404` 主清单不存在（产物已清理） |
| `GET /v1/media/{id}/manifest/*?t=<m>&tpl=<可选>` | token `m` | `200` 改写后子清单（通配段为子清单相对路径，如 `720p/index.m3u8`）；`EXT-X-KEY` URI → `/v1/media/{id}/key?t=<k token>`；**分片 URI → 对象存储预签名 GET 直出**（可经 `STORAGE_CDN_BASE_URL` 换 origin，字节不经分发端） | 路径白名单不符 → `404`（先于鉴权）；`404` 子清单不存在 |
| `GET /v1/media/{id}/key?t=<k>` | token `k` | `200` **裸 16 字节 CEK**（`application/octet-stream`，`no-store`，`Content-Length: 16`）；kid / method / iv 不下发 | `404` 该媒资无密钥；`500` MK 缺版本 / 密钥不可用 |
| `GET /v1/media/{id}/subtitles/{trackId}.vtt?t=<v>` | token `v` | `200` WebVTT 文本（`text/vtt; charset=utf-8`，`no-store`）；按 DB 行内 `storage_key` 取对象 | `trackId` 形状不符 → `404`（先于鉴权）；未就绪/已删除 → `404` |

```bash
ffprobe "$MF" && ffmpeg -i "$MF" -c copy /tmp/out.mp4     # 真播放器视角（自动取密钥 + 本地解密）
```

---

## 3. 附录

### 3.1 状态码速查

| 码 | 含义与典型场景 |
|---|---|
| `200 / 201 / 202` | 成功；新建（上传媒资、字幕、分类、模板、用户）返回 `201`；转码入队 `202` |
| `204` | 分发端 `OPTIONS` 预检 |
| `302` | 管理端 `original` / `cover` 重定向到对象存储预签名 URL |
| `400` | 参数 / body 校验失败（zod 首条 issue 带字段路径）、ID 形状非法、上游业务校验（VTT、时间轴） |
| `401` | 管理端无会话 / 向导未完成；分发端 JWT 无效 |
| `403` | 分发端签名 token 缺失或无效（`bad_token`）；管理端设置写入 Origin 守卫；`/api/setup` 已完成 |
| `404` | 资源不存在（媒资 / 分类 / 模板 / 密钥 / 轨道 / 产物 / 任务） |
| `409` | 冲突：同级重名、环路、系统默认分类不可删、有子分类、同模板在跑、会话并发上限（`session_limit`）、媒资不可播（`not_playable`）、设置 revision 冲突 |
| `413 / 415` | 管理端设置写入：body 过大 / `Content-Type` 非 JSON |
| `501` | 管理端未实现路径；分发端预览账号未配置（`preview-play`） |
| `502 / 503` | 管理端预览不可达；分发端未配置 JWT 签名密钥 |

### 3.2 审计动作名

`media.upload` · `media.rename` · `media.metadata_update` 🆕 · `media.metadata_generate` · `media.delete` ·
`media.cover_upload` · `media.transcode_submit` · `media.product_delete` ·
`subtitle.create` · `subtitle.update` · `subtitle.delete` ·
`category.create` 🆕 · `category.update` 🆕 · `category.delete` 🆕 ·
`template.create` · `template.update` · `template.delete` ·
`watermark.create` 🆕 · `watermark.update` 🆕 · `watermark.image_upload` 🆕 · `watermark.delete` 🆕 ·
`key.delete` · `key.rotate_mk` · `transcode.stop` · `transcode.restart` ·
`user.create` · `user.update` · `user.delete` · `user.password_reset` · `user.revoke_sessions` ·
`settings.update` · `console.login` · `console.login_failed`

> `media.transcode_submit` 的 `detail` 含 `{job_ids, template_ids, watermark_ids}`（`watermark_ids` 为本次提交实际携带水印的任务所关联的水印模板 ID 列表，spec.md §10.7；未关联水印的模板不计入）。

### 3.3 已知差异与未实现项

| 项 | 说明 |
|---|---|
| `GET /v1/media` 的 `limit` | 实现：缺省 50 / 1..200 静默回退；契约 `PageQuery`：缺省 20 / 1..100 —— 以本文件（实现）为准 |
| `cursor` 分页 | 未实现，`next_cursor` 恒 `null`（ADR-0010 契约留待后续） |
| `typ=s`（分片 token） | 已定义但无路由签发 / 校验：分片走对象存储预签名直出 |
| 登录限频 / 严格模式 | 未实现（ADR-0010 演进项） |
| 管理端 `GET /api/admin/media/{id}` | 实现未返回 contracts `MediaDetail` 声明里的 `subtitles` / `playable`（字幕另见 `/subtitles` 端点） |
| `SUBTITLE_CONTENT_TYPE` | `text/vtt; charset=utf-8`（`@openvod/shared`） |
| `/healthz` 之外的根路径 | 分发端走 chi 默认 404（非错误信封）；`/v1` 未注册路径返回 `404 {"error":{"code":"not_found","message":"路由不存在"}}` |
| 管理端未实现端点 | 由 `/api/admin/[...path]` 返回 `501 not_implemented`（该响应不带 `no-store` 头） |
| 管理端 catch-all 守卫 | `/api/admin/[...path]` 只校验会话（未校验向导完成标记）；已实现端点统一经 `getAdminSession`（会话 + 向导完成两者都查） |
