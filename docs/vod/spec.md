# Specification — OpenVOD v1 功能规范

- 日期：2026-09-18
- 状态：生效中（随功能实现演进）
- 用法：本文件记录进入实现阶段的**功能规范**（做什么、按什么规则做）；方案取舍与背景见 `decisions/`（ADR）。ADR 与本文件冲突时，以本文件为准并回写 ADR。

## 1. 媒资存储布局（对象存储键规范）

> 取代 ADR-0005「存储布局（键规范）」小节的旧布局（`raw/` / `hls/` / `sub/` / `thumb/`）。

### 1.1 Root 全局前缀

- 所有 OpenVOD 资产存放在一个**全局 root 前缀**之下（环境变量 `STORAGE_ROOT_PREFIX`，如 `vod`）；
- root **不要求位于桶根目录**：可与其它业务共用一个桶，靠 root 隔离；也可以为空（资产直接落在桶 / local 根目录顶层）；
- root 前缀由**存储适配层统一拼接**（`packages/storage` 的 `rootPrefix` 配置）：业务代码与键常量（`@openvod/shared` 的 `STORAGE_KEYS`）永远只写不含 root 的相对键；
- 分区目录直接挂在 root 下：`{root}/original/...`、`{root}/proceed/...`、`{root}/cover/...`、`{root}/metadata/...`。

### 1.2 分区（一级目录）

root 下按资产类别分四个分区，互不嵌套：

| 分区 | 内容 | 写入方 | 读取方 |
|---|---|---|---|
| `original/` | 原始上传视频，一个媒资一个文件 | 管理端 | Worker（转码源） |
| `proceed/` | 转码与处理产物：HLS 主/子清单、分片、字幕等 | Worker / 管理端 | 分发端（经 CDN / TypeA）、管理端 |
| `cover/` | 封面与图片资产（poster、缩略图等） | Worker / 管理端 | 分发端、管理端 |
| `metadata/` | 元数据：ffprobe 结果、业务扩展元数据等 | 管理端 / Worker | 管理端 / 分发端 |

- P0 纪律不变：**密钥材料绝不入对象存储**（wrapped CEK、JWT 私钥仅入数据库，ADR-0006）；
- 原视频与转码产物分区分开的动机：`original/` 只增不改（审计友好、误删可恢复），产物可随时按 ladder 重转并整体重建。

### 1.3 媒资 ID（数字索引）

- 原视频上传成功后，系统为其生成**唯一数字 ID**；该 ID 是获取**原视频、转码产物、封面图片、元数据**等全部资产的**唯一索引**；
- ID 为**纯数字字符串**，**默认 8 位，长度可配置**（`MEDIA_ID_LENGTH`，范围 4–16）；不足位数**保留前导零**（如 `00000042`）；
- 生成规则：在 `[10^(n-1), 10^n)` 的 n 位数字空间内服务端随机取值，落库/落存储前校验唯一性，冲突重取；以字符串形式传输与存储（避免数值类型丢失前导零），排序与展示按数值语义；
- ID 落库（M1 实现，2026-09-18）：ID 即 `media.id` 主键（`VARCHAR(191)`，应用层生成，不用 cuid），与 `original/{id}.{ext}` 唯一一一对应；`media.title` 为展示名（重命名目标，可改），`media.source_key` 冗余记录 original 键。生成器在 `@openvod/shared`（`generateMediaId` / `resolveMediaIdLength`，逐位独立取 `[0,9]` 保留前导零）；
- 一个媒资的完整资产集合即同 ID 在四个分区下的所有对象：

```
{root}/original/{id}.{ext}                                  # 原始上传（唯一确定媒资存在的对象）
{root}/proceed/{id}/{templateId}/master.m3u8                # HLS 主清单（按模板分组；改写发生在分发端）
{root}/proceed/{id}/{templateId}/{variant}/index.m3u8       # 子清单
{root}/proceed/{id}/{templateId}/{variant}/seg-{n}.ts       # 分片（AES-128 加密）
{root}/proceed/{id}/subtitles/{trackId}.vtt                 # 字幕（保留段，不属于任何模板产物）
{root}/cover/{id}/poster.jpg                                # 海报 / 封面图
{root}/metadata/{id}/probe.json                             # ffprobe 系统元数据
{root}/metadata/{id}/custom.json                            # 业务扩展元数据
```

`proceed/` 的**两级分组**（2026-09-18 定，M2 落地）：

- 第一级是媒资 ID，第二级是**模板 ID**（即 `transcode_templates.id`，cuid）：目录名就是模板 ID，所以「这份产物是哪个模板转出来的」可以直接从存储键读出；
- 同一媒资**允许多套模板产物并存**（如「原画加密」与「1080p 加密」各一套），互不覆盖；重转某个模板只替换 / 清理**该模板子树**（§5.2）；
- 单次发起转码可**多选模板**（§2.1）：每个模板各入队一条任务、各落一个 `proceed/{id}/{templateId}/` 子树，一次提交即可同时产出多套互不覆盖的产物；
- `proceed/{id}/subtitles/` 是**保留段**：字幕不属于模板产物，不参与模板分组。模板 ID 为 cuid 形状（`TEMPLATE_ID_PATTERN = /^c[a-z0-9]{20,}$/`），与保留段不会冲突；
- **旧布局兼容**：M2 之前的产物落在 `proceed/{id}/{variant}/…`（无模板段），列举时归入空模板 ID 并展示为「未分组（旧布局）」；对该媒资重转码一次即可迁到新布局。

### 1.4 媒资列举规则（管理端「媒资列表」）

- **媒资集合以 `original/` 分区为准**：每个 `original/{id}.{ext}` 对象即一个媒资，`id` = 文件名去扩展名；
- `id` 必须为纯数字（`MEDIA_ID_PATTERN`）；非数字文件名或更深层级的对象不属于媒资，列举时忽略；
- 其余三个分区**只按 id 归组补充资产状态**（各分区下该 id 的对象数量），不反向定义媒资；
- `proceed/` 额外按「媒资 → 模板」归组为 `products[]`（M2 实现）：每项给出 `template_id`、`template_name`（查 `transcode_templates`，模板已删为 `null`）、`objects`（对象数）、`bytes`（体积）、`variants[]`（变体目录名，如 `1080p` / `720p`）——列表与详情都用它回答「这份产物是哪个模板转的」；`proceed/{id}/subtitles/` 等保留段不参与分组；
- 管理端 `GET /api/admin/media` 一次列举四个分区并按 id 内存聚合返回；v1 全量列举即可，分页 / 前缀裁剪留待媒资规模需要时再加；
- 列表同时合并 `media` 表（M1 实现，见 §2.1）：展示名（`title`）与生命周期状态由数据库补充，DB 查询失败时降级为纯存储视角（字段置 null）；数据库行**不参与**媒资集合定义（仍以 `original/` 分区为准）。

### 1.5 相关环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `STORAGE_ROOT_PREFIX` | 空 | 全局 root 前缀（可多级，如 `prod/vod`），空 = 桶顶层 |
| `MEDIA_ID_LENGTH` | `8` | 媒资数字 ID 位数（4–16） |

## 2. 管理端 API（控制面，`/api/admin/*`）

- 复用 better-auth 会话守卫（Cookie），未登录 401；错误响应统一 `{ error: { code, message } }`，错误码沿用 `@openvod/shared ERROR_CODES`（含 `bad_request`，2026-09-18 扩充）；
- 上传协议（M1）：原视频 / 封面上传以**原始文件字节流**为请求体（`Content-Type: application/octet-stream`），文件名 / 展示名走查询参数——流式直传不经过 multipart 缓冲，服务端内存占用与文件大小无关；
- 管理端 API 响应一律 `Cache-Control: no-store`；敏感操作（上传 / 重命名 / 删除 / 封面）落 `audit_logs`（open-questions #14）。

### 2.1 已实现（M1 媒资管理 + 密钥管理 + M2 转码，2026-09-18）

| 端点 | 方法 | 说明 |
|---|---|---|
| `/api/admin/media` | GET | 媒资列表（§1.4 存储视角 + DB 展示名/状态合并）；每条含 `products[]`——按模板分组的转码产物（模板名 / 对象数 / 体积 / 变体），旧布局产物归入 `template_id=""` |
| `/api/admin/media/upload` | POST | 原视频上传（§1.3）：生成数字 ID（主键冲突即重取）→ 流式写 `original/{id}.{ext}` → `media` 行落库；存储失败回滚 DB 行 |
| `/api/admin/media/{id}` | GET | 详情：存储资产计数 + DB 元数据合并 + `products[]`（每套模板产物的模板名 / 变体 / 对象数 / 体积，模板 ID 可追溯到 `proceed/{id}/{模板id}/`） |
| `/api/admin/media/{id}` | PATCH | 重命名：仅修改 `media.title`，绝不改动 original 文件名与媒资 ID |
| `/api/admin/media/{id}` | DELETE | 删除：original 对象 + proceed/cover/metadata 三分区该 id 全部对象 + DB 行（级联 subtitles / transcode_jobs / hls_keys / playback_sessions）；幂等可重试。**级联范围说明**：open-questions #13 决议（软删 + 保留期 GC）之前的 v1 临时策略为**硬删除全级联** |
| `/api/admin/media/{id}/original` | GET | 原视频预览：local 模式 Range 字节区间流式代理（206）；s3 模式预签名 GET 302 重定向（字节不经管理端）；no-store |
| `/api/admin/media/{id}/cover` | POST | 上传封面：`cover/{id}/poster.{ext}`（jpg/png/webp/gif/avif）+ 回写 `media.poster_key`；手动上传 / 视频截帧双模式共用此端点（§2.3） |
| `/api/admin/media/{id}/cover` | GET | 封面图片读取（列表首列缩略图 / 详情展示，§3.1）：local 整对象流式输出；s3 预签名 GET 302（字节不经管理端）；no-store |
| `/api/admin/media/{id}/metadata` | POST | 生成元数据：ffprobe 探测 original（local 直读文件路径 / s3 预签名 GET URL 供流）→ 原始输出落 `metadata/{id}/probe.json`，归一化摘要（宽高 / 帧率 / 色彩空间 / 编码 / 码率 / 音轨等，`@openvod/transcode summarizeProbe`）回写 `media.probe` + `media.duration_ms`；幂等覆盖式更新；落 `audit_logs`（`media.metadata_generate`）。要求运行环境安装 ffprobe |
| `/api/admin/keys` | GET | 密钥列表（§4.3）：`hls_keys` + 媒资展示名/状态 + proceed 对象数（存储不可用时为 null）；**响应中不存在任何密钥材料字段**（契约层就不定义） |
| `/api/admin/keys/{mediaId}` | GET | 密钥详情：kid / method / iv / mk_ver / 生成时间 / 使用中会话数；明文 CEK 永不返回 |
| `/api/admin/keys/{mediaId}` | DELETE | 删除该媒资密钥行；存在未过期播放会话时 **409 拒绝**；落 `audit_logs`（`key.delete`） |
| `/api/admin/keys/mk` | GET | MK 版本状态：当前封装版本 + 各版本密钥用量（只暴露版本号与计数，无密钥材料） |
| `/api/admin/keys/rotate-mk` | POST | MK 轮换：把旧版本封装的 CEK 重封装到当前版本（`MASTER_KEYS` 最大版本），**无需重转码**；落 `audit_logs`（`key.rotate_mk`）。v1 同步执行，超大数据量演进为任务化分批 |
| `/api/admin/media/{id}/transcode` | POST | 发起转码（M2，§5）：请求体 `template_ids[]`（**多选**，去重、单次上限见契约 `TRANSCODE_SUBMIT_MAX_TEMPLATES`）；校验媒资与原始文件存在、每个模板存在、`encrypt && format!=='HLS'` 拒绝、同一媒资**同一模板**无未终结任务（409，不同模板可并行）→ 每个模板各自**快照**入队 `transcode_jobs`（`QUEUED`，整批同一事务）；返回 202 `{jobs:[{job_id,template_id,template_name,status}]}`；落 `audit_logs`（`media.transcode_submit`，detail 含全部 `job_id` / `template_id`）。**此阶段不生成 argv**（源参数未知，ADR-0014） |
| `/api/admin/jobs` | GET | 转码任务列表（创建时间倒序，最多 200 条）：状态、模板名（取快照，模板已删也可追溯）、`attempts`、`last_error`、各时间戳，并关联媒资展示名 |
| `/api/admin/jobs/stream` | GET | 转码任务实时推送（SSE，`text/event-stream`）：连接即回放全量快照（`event: jobs`），此后**仅当任务快照变化时**推送全量（幂等覆盖，避免空转）；15s `event: ping` 保活心跳；断线由浏览器按 `retry` 提示自动重连（重连即重新校验会话）、连接 10 min 到期主动断开重连。**客户端不轮询**；服务端由进程内 hub（`lib/jobs-stream`）观察 DB 变化——Worker 是独立进程且 MySQL/SQLite 无跨进程通知，管理端只能观察自己的库；全部连接共享同一观察循环，订阅者归零即停机；响应 `no-store` / `X-Accel-Buffering: no` |
| `/api/admin/media/{id}/preview-play` | POST | 「产物解密播放」预览：请求体 `template_id`（可选；**空串 = 显式请求旧布局产物**，缺省由分发端自动选择，§6.3）。服务端以**预览账号**（`DELIVERY_PREVIEW_USERNAME/PASSWORD`）调分发端 login + play，返回 `{sid, manifest_url, expires_at, template_id, encrypted}`；浏览器用 hls.js / Safari 原生直接播该签名清单——清单 / 密钥 / 分片直达浏览器，**管理端不接触密钥材料**（P0，§4.3）。未配置预览账号返回 501 |
| `/api/admin/media/{id}/products/{templateId}` | DELETE | 删除一套转码产物：`templateId` 为模板 cuid（删 `proceed/{id}/{templateId}/` 子树）或 `legacy`（旧布局：删 `proceed/{id}/` 顶层非保留段对象）。**只删存储对象**：`hls_keys`（可能被其它模板产物共用）与 `transcode_jobs` 历史保留；同模板存在未终结任务 → 409；不存在 → 404；落 `audit_logs`（`media.product_delete`，detail 含 template_id / objects / bytes） |
| `/api/admin/jobs/{id}/stop` | POST | 停止（取消）任务：置 FAILED（`last_error=已手动停止（管理端）`）+ 清租约。仅对 **QUEUED**（撤下队列，不再被认领）或**租约已过期**的执行中任务（worker 失联，安全终止）开放；租约有效（worker 正在执行）→ 409。写入用 CAS（状态未变才生效）。落 `audit_logs`（`transcode.stop`） |
| `/api/admin/jobs/{id}/restart` | POST | 重启（重新入队）：仅 **FAILED**（失败或手动停止）——`attempts` 清零（否则认领逻辑会立即判「超过重试上限」）+ 清错误 / 租约 / 时间戳 → QUEUED，由 worker 重新认领。落 `audit_logs`（`transcode.restart`） |
| `/api/admin/stats` | GET | 控制台总览统计（intent.md「控制台总览」）：`media`（`total` 以 `original/` 分区为准、`ready` 为 `status=READY` 且已入库、`not_ingested` 为有 original 对象但无 `media` 行）、`jobs`（未终结任务按 QUEUED / PROBING / ENCODING / PACKAGING 计数 + `active` 合计）与 `users`（`total` / `active` / `disabled`，ADR-0007）。只读聚合：媒资只列举 `original/` 一个分区 + 两次 DB COUNT，任务为四次 DB COUNT，用户为两次 DB COUNT，均不拉取行 |
| `/api/admin/users` | GET | 播放端用户列表（ADR-0004 `users` 表；ADR-0007 账户域，创建时间倒序）：用户名 / 展示名 / 状态 / 并发上限 / 进行中会话数 / 最近登录 / 注册时间。**响应不含 `password_hash`**（契约层不定义该字段，管理端无查看口令哈希的入口）。「进行中会话数」= `playback_sessions` 中未吊销且未过期的条数（批量 groupBy 一次统计） |
| `/api/admin/users` | POST | 新建播放端用户：`username` + `password`（后者 bcrypt cost 12 摘要后入库，ADR-0007）→ 默认 `ACTIVE`；可选 `display_name` / `max_concurrent_sessions`。用户名重复 409；用户名或口令不合法 400。落 `audit_logs`（`user.create`） |
| `/api/admin/users/{id}` | GET | 用户详情：DTO + 进行中会话数（404 若用户不存在） |
| `/api/admin/users/{id}` | PATCH | 更新展示名 / 状态 / 并发上限（**用户名创建后不可修改**——口令与用户名变更分别走重置密码 / 新建+删除）。**封禁（ACTIVE → DISABLED）立即吊销该用户全部未过期会话**（ADR-0007：封禁 → 登录拒绝 + 全会话吊销），吊销条数随响应 `revoked_sessions` 返回；重复封禁 / 解除封禁不触发吊销。落 `audit_logs`（`user.update`，detail 含 `revoked_sessions`） |
| `/api/admin/users/{id}/password` | POST | 重置口令（`password`，bcrypt cost 12）：凭据变更后同样**立即吊销该用户全部未过期会话**（否则已下发 JWT 在 exp 前仍可播放），`revoked_sessions` 随响应返回。落 `audit_logs`（`user.password_reset`） |
| `/api/admin/users/{id}/revoke-sessions` | POST | 手动吊销该用户全部未过期会话（用户仍为 `ACTIVE`，可重新登录），返回 `revoked_sessions`。落 `audit_logs`（`user.sessions_revoke`） |
| `/api/admin/users/{id}` | DELETE | 删除用户：`playback_sessions` 随用户级联删除（Prisma `onDelete: Cascade`，等价于全会话吊销），响应用级联条数回报。落 `audit_logs`（`user.delete`） |

### 2.1.1 播放端用户（ADR-0004 / ADR-0007）

- 用户表由管理端全量 CRUD，分发端 login 只读校验（`status=ACTIVE` 才允许登录）；已下发分片 token 在自身 `exp` 内仍有效（ADR-0006 已声明接受），吊销只影响新请求；
- 口令只写不读：接口入参只接受明文口令并即时 bcrypt 摘要，响应与契约**均无口令 / 哈希字段**；`max_concurrent_sessions` 为 `0` 表示不限制（ADR-0007）；
- 管理端用户（`admin_users` + better-auth Cookie 会话）与播放端用户（`users` + ES256 JWT）是两套体系，切勿混用。

### 2.2 未实现（501 占位，随里程碑落地）

| 端点 | 归属 | 说明 |
|---|---|---|
| `/api/admin/media/{id}/subtitles` | M4（ADR-0009） | 字幕上传 / 管理：VTT → `proceed/{id}/subtitles/` 并绑定媒资 ID |

- 未实现端点统一由 `/api/admin/[...path]` 返回 501 `not_implemented`（会话守卫仍然生效）；管理端 UI 对应项为 TODO 提示（点击提示所属里程碑）。

### 2.3 封面设置（poster，双模式）

媒资封面落位与回写对所有模式一致（open-questions #11：v1 每媒资仅一张 poster）：

- 落键 `cover/{id}/poster.{ext}`（spec.md §1.3），**覆盖式写入**（重复设置直接替换旧 poster）；
- 成功后回写 `media.poster_key`；落 `audit_logs`（动作 `media.cover_upload`）；
- 端点统一为 `POST /api/admin/media/{id}/cover`（原始图片字节流，octet-stream，§2 上传协议），不同模式仅是字节来源不同，服务端无差别。

**模式 A：手动上传（已实现）**

- 弹窗拖拽 / 选择本地图片（jpg / png / webp / gif / avif），原始字节直传端点。

**模式 B：视频截帧（已实现，2026-09-18）**

- 弹窗内播放 original 原视频（「手动上传 / 视频截帧」双 Tab 中的截帧 Tab，`<video>` 原生控件），**拖拽进度条选择目标时间点**（antd Slider，拖拽期间挂起播放进度回写），取当前帧画面作为封面；
- 截帧在**浏览器侧**完成（`<video>` 当前帧 → canvas → JPEG），不依赖 ffmpeg / Worker，服务端零新增负载；产物以 `poster.jpg` 字节走同一端点，服务端逻辑与模式 A 完全一致；
- 导出约束：JPEG 质量 0.9；帧分辨率超过 1280px 最长边时等比缩小（控制封面体积）；
- 跨域前置：local 模式预览为同源 Range 代理，可直接截取；s3 模式预览为预签名 302 跳转，`<video>` 必须显式 `crossOrigin="anonymous"` 以 CORS 模式拉流（媒体元素默认 no-cors，即使桶已放行 CORS 画布仍会被污染、导出抛 SecurityError）；**要求对象桶 CORS 允许管理端源站**（AllowedOrigin 与页面源站含协议端口精确匹配、Method 含 GET 与 OPTIONS——Range 头触发预检、AllowedHeader 含 Range 或 `*`）；CORS 未放行时视频直接加载失败（onError 提示排查项并回退手动上传），不阻塞端点。

## 3. 管理端页面

### 3.0 表格滚动约定（2026-09-18 用户规定，所有管理相关表格强制）

- 所有管理相关表格**必须**「表体限高、内部纵向滚动、表头固定」，页面本身不随条目数增长；内容超长必须滚动，不得撑开页面；
- 超宽表格同时横向滚动（antd `scroll.x` = 各列宽合计）；
- 统一复用 `apps/admin/src/components/tableScroll.ts` 的 `useTableBodyHeight`（视口高度推算 + resize 重算 + 极窄视口兜底），**不得各自实现**；
- 已实现页面：`/media`（媒资列表）、`/templates`（转码模板）、`/users`（播放端用户）、`/keys`（密钥）、`/jobs`（转码任务）；后续所有表格页面同样遵循。

### 3.1 已实现页面

- `/media`（媒资管理，M1/M2 已实现，M3 增产物操作）：媒资列表表格——**封面缩略图（首列，antd Image，经 GET `/cover` 读取，点击预览大图；未设置显示「未设置」）**、**展示名（第一行为展示名，第二行为媒资 ID 代码样式；右侧复制按钮一键复制 ID + 重命名按钮）**、生命周期状态、原始文件（格式 / 大小 / 上传时间）、**转码产物（按模板分组：`N 组产物 · M 个对象`，悬停列出每套产物的模板名与档位，点击打开产物列表）**；详情弹窗显示产物组数并提供「产物列表（播放 / 删除）」入口（不再逐套平铺）；
  - **产物列表（抽屉，按模板一行）**：模板名（已删显示「模板已删除（id 前缀）」；旧布局显示「未分组（旧布局）」）、存储前缀 `proceed/{id}/{模板id}/`、变体（`1080p / 720p`）、对象数、体积；操作：
    - **播放** = 解密播放预览（`POST /media/{id}/preview-play` → 分发端签名主清单 URL → hls.js / Safari 原生播放，浏览器本地解密；管理端不出密钥，§4.3），播放弹窗标注「AES-128 加密（浏览器本地解密）」或「未加密」与模板 ID；
    - **删除** = 按模板删除该套产物（`DELETE /media/{id}/products/{templateId}`；确认弹窗给出前缀 / 对象数 / 体积与不可恢复警告；同模板有进行中任务时 409，需等待其结束）；
  - 播放失败的常见排查提示直接展示在弹窗内：分发端 CORS（`DELIVERY_CORS_ORIGINS`）或对象桶 CORS 未放行管理端源站；预览账号未配置时接口 501（dev-workflow §5.3）；
- `/templates`（转码模板，ADR-0014 已实现）：模板列表表格——模板名（默认标记）、描述、模式（转码 / 保持原视频）、加密（AES-128）、格式（M3U8）、参数摘要（编码器 / 码率或 CRF / 分辨率档位 / 帧率 / preset）、更新时间；操作：新建 / 编辑（弹窗表单，含分辨率档位多行编辑：固定宽×高或自适应上限约束）、删除（确认弹窗注明已发起任务不受影响）；API 见 §2（`/api/admin/templates`）。
- `/users`（播放端用户，ADR-0004 `users` 表 / ADR-0007 账户域）：用户列表表格——用户名（加粗，已封禁标红 Tag）、展示名、状态（可用 / 封禁 Tag）、并发上限（`0` 悬停提示「0 = 不限制」）、进行中会话数、最近登录、注册时间；操作：新建 / 编辑（弹窗表单：用户名创建后为只读，口令仅新建时可填，状态用 Switch，并发上限 0–10000）、重置密码（独立弹窗，双口令确认，提示将吊销全部会话）、吊销会话（有会话时才可点）、封禁 / 启用、删除（确认弹窗区分「级联删除会话」与「封禁后可恢复」）。页面**不提供口令 / 哈希的查看与导出入口**；API 见 §2.1.1。
- `/keys`（密钥管理，已实现）：密钥列表表格——媒资 ID、展示名、媒资状态、kid（截断 + Tooltip 全量）、算法、MK 版本（非当前版本标「待轮换」）、加密产物对象数、生成时间；顶部条展示当前封装版本与各版本密钥用量；操作：详情（弹窗：kid / IV / mk_ver / 生成时间 / 使用中会话数，并明确标注「明文密钥不展示」）、删除（确认弹窗警告需重转码才能恢复可播）、「轮换 MK」（确认后重封装旧版本，无需重转码）；API 见 §2.1 与 §4.3。**页面不提供任何明文密钥的展示 / 导出入口**。
- `/jobs`（转码任务，M2 已实现，M3 增停止 / 重启）：任务列表表格——任务 ID、媒资（ID + 展示名）、状态（排队 / 探测中 / 转码中 / 封装上传中 / 完成 / 失败；worker 失联的执行中任务标「中断」）、模板名（取任务快照）、尝试次数、耗时、失败原因、创建时间；**操作列**：停止（取消）/ 重启（重新入队），规则见 §5.1；**实时推送（SSE）**——连接即回放全量快照，任务变化由服务端主动推送（客户端零轮询），断线自动重连并展示连接状态；「刷新」= 重建连接（服务端随即回放最新快照），「耗时」列由本地时钟每秒重算（不发请求）；API 见 §2.1（`/api/admin/jobs`、`/api/admin/jobs/stream`、`/api/admin/jobs/{id}/stop|restart`），执行规则见 §5。
- 操作（对应 §2.1）：上传视频（原始字节流直传，带进度）、预览（弹窗 `<video>` 播放 original，local 支持 Range 拖动）、详情（弹窗展示元数据：probe 摘要结构化展示——容器 / 分辨率 / 帧率 / 编码 / 像素格式 / 色彩空间 / 码率 / 音轨等 + 摘要 JSON 折叠块）、重命名（仅展示名）、删除（确认后硬删除全级联）、设置封面（弹窗双模式：手动上传 / 视频截帧，§2.3）、「更多 → 生成元数据」（ffprobe 探测，§2.1）、「更多 → 转码」（M2 已实现：弹窗**多选**模板（默认勾选默认模板）→ 逐个展示所选模板的模式 / 加密 / 输出格式 → 一次发起入队多条 `transcode_jobs`（每个模板各一条、各落 `proceed/{id}/{模板id}/`），进度跳「转码任务」页查看）；「更多 → 字幕管理」为 TODO（§2.2）。

## 4. 密钥管理与视频加密（以 ADR-0006 为决策源）

> 本节把 intent.md「加密分发」「密钥管理」与「转码模板管理 → 是否加密」落实为可实现规范；与 ADR-0006 冲突时以本节为准并回写 ADR。

### 4.1 密钥模型（v1 硬约束）

```
MK（环境变量 MASTER_KEYS="版本:64位hex"，可多版本轮换，ADR-0006 §1）
 └─ AES-256-GCM 封装 → CEK（16B，**每媒资一份**，用于加密该媒资全部分片）
```

- **每媒资一份 CEK**：`hls_keys` 与 `media` 一对一（`media_id` **DB 唯一约束**，见 `packages/db/prisma` 与迁移 `20260918220000_hls_keys_media_unique`）；同一媒资的多码率档位 / 同一任务的多档产物**共用同一 CEK 与 kid**（清单 `EXT-X-KEY` 一致）；
- **不存在固定密钥 / 共享密钥，也不存在「选择密钥」这一步**：模板的 `encrypt`（intent.md「转码模板管理」）仅决定「是否加密」，密钥由 Worker 在执行任务时随机生成；管理端不提供指定、复用、导入或替换密钥的能力。动机是**限制泄露爆炸半径**：单媒资 CEK 泄露只损失该媒资且可经会话吊销 / 重转码收敛；固定密钥一旦泄露则全部媒资同时失效且无法收敛；
- **明文 CEK 只存在于两个瞬间**：转码期写入 ffmpeg `key_info` 临时文件的瞬间、密钥接口响应（`GET /v1/media/{id}/key`）的瞬间；落库仅 `wrapped_cek`（MK 封装）+ `iv` + `kid` + `mk_ver`，对象存储与日志中永不出现明文密钥；
- v1 **每个媒资只有一份有效密钥行**（不做按媒资的密钥版本并存 / 双 kid 宽限；该能力属 CENC 演进，ADR-0006 备选记录）。

### 4.2 生成与落库（Worker）

**实现位置（密钥部分已落地，2026-09-18）**：

- 生成 / 解封 / 重封装纯函数在 `packages/crypto`（`createMediaKey` / `openMediaKey` / `resealMediaKey` / `pickWrappingMasterKey`，13 项单测覆盖生成、往返解封、错误 MK、篡改、轮换幂等）；
- Worker 编排在 `apps/worker/src`：`media-keys.ts`（`loadMasterKeys` / `describeMasterKeys` / `generateMediaKey` / **`resolveMediaKey`** / `persistMediaKey`）、`media-key-store.ts`（Prisma 事务整行替换的 `MediaKeyStore`）、`key-files.ts`（`keyUriPlaceholder` / `writeKeyFiles` / `cleanupJobDir`）、`executor.ts`（整条转码链）；
- 管理端 MK 轮换复用同一组 crypto 函数（§4.3）；Worker 启动时做 MASTER_KEYS 自检（不可用只告警：未加密模板不依赖它）。

**执行顺序（顺序即安全边界）**：

1. `resolveMediaKey(store, mks, mediaId)`：该媒资**已有密钥行 → 解封复用**（多模板产物共用一份 CEK），否则 `generateMediaKey(mks)` 生成新的——**两种情况都此时不落库**；
2. `writeKeyFiles` 写 `{jobDir}/key_info` 与 `{jobDir}/ceks/{kid}.key`（CEK 为 **16 字节裸字节**）；key_info 三行 = 占位密钥 URI / CEK 文件路径 / **纯 hex IV**：
   - 第三行**不能带 `0x`**——ffmpeg 会自行加前缀，带上即产出 `EXT-X-KEY:...IV=0x0x…` 并报 `Error setting option encryption_iv`，加密失败且分片不产出（实测 ffmpeg 6.1）；`buildKeyInfoFile` 已归一化并有单测守卫（`packages/transcode`）；
3. ffmpeg 输出 AES-128 加密的 TS 分片 → 上传至 `proceed/{id}/{templateId}/{variant}/`（§1.3）；
4. **产物上传全部成功后**，仅当步骤 1 是**新生成**时才 `persistMediaKey(store, mediaId, key)` → 写 `hls_keys`（每媒资一份，见下）；复用时无需写库；
5. 任务结束（成功 / 失败 / 取消）**必须** `cleanupJobDir(jobDir)`：key_info 与明文 CEK 随目录删除，不得残留。

**每媒资一份的落库语义（v1）**：`hls_keys.media_id` 唯一约束使「先插新行再删旧行」不可行，故存储层在**单个事务内先删旧行、再写新行**：

- 成功：旧 kid 立即失效，媒资恒只有一行密钥；
- 任一步失败：事务整体回滚，**旧密钥行原样保留**（不会出现「既无新也无旧」的空洞）——已有测试覆盖（kid 撞车场景）；
- 因此**绝不能提前落库**：若在转码前落库，一次失败的转码就会换掉该媒资密钥，使既有加密产物永久无法解密；
- **多模板产物共用一份 CEK**（§1.3：`proceed/{id}/{templateId}/` 可并存多套）：加密任务先 `resolveMediaKey` 解封复用已有密钥，只有该媒资**从未加密过**时才生成新密钥 → 用模板 B 转码不会让模板 A 的密文失效；
- 因此 **CEK 轮换（重加密）= 重转码该媒资的全部模板产物**，单模板重转码不换密钥；也不做同媒资多版本密钥并存 / 双 kid 宽限。

### 4.3 管理端密钥接口（只读 + 生命周期操作）

| 端点 | 方法 | 说明 |
|---|---|---|
| `/api/admin/keys` | GET | 密钥列表：`media_id`、展示名、媒资状态、`kid`、`method`、`mk_ver`、生成时间、加密产物对象数（存储不可用为 null） |
| `/api/admin/keys/{mediaId}` | GET | 单媒资密钥详情：`kid` / `method` / `iv` / `mk_ver` / 生成时间 / 未过期的播放会话数 |
| `/api/admin/keys/{mediaId}` | DELETE | 删除该媒资密钥行；**存在未过期播放会话时 409 拒绝**（避免打断在播会话），先吊销会话再删 |
| `/api/admin/keys/mk` | GET | MK 版本状态：当前封装版本（`MASTER_KEYS` 最大版本）+ 各版本密钥用量 + 密钥总数 |
| `/api/admin/keys/rotate-mk` | POST | MK 轮换：按行自身 `mk_ver` 解封、以当前版本重新封装（可传 `from_ver` 限定来源版本）；**无需重转码**。v1 同步逐行执行，超大数据量演进为任务化分批 |

**P0 红线（评审与测试用例）**：

- 任何管理端接口 / 页面 / 日志 / 错误信息**不得返回明文 CEK**（`packages/contracts` 的密钥 DTO 里根本不定义该字段，从类型层杜绝）；明文 CEK 的唯一出口是分发端 `GET /v1/media/{id}/key?t=`（token(k)、no-store，ADR-0006 §3）；
- 管理端无「显示 / 导出密钥」入口；
- 密钥表操作（DELETE / `rotate-mk`）落 `audit_logs`（open-questions #14，动作 `key.delete` / `key.rotate_mk`）；
- 管理端页面 `/keys`（已实现）：密钥列表表格（遵循 §3.0 表格滚动约定）+ 顶栏 MK 版本与用量 + 详情 / 删除 / 轮换，**不展示任何明文密钥**；页面明细见 §3.1。

### 4.4 轮换与吊销

| 对象 | 方式 | 影响 |
|---|---|---|
| MK | 在 `MASTER_KEYS` 新增版本号（旧版本保留）+ 管理端「轮换 MK」（`POST /api/admin/keys/rotate-mk`）重封装 | 无需重转码；轮换期间播放不受影响（先解封再重封装，字节未变） |
| CEK | 重转码该媒资的**全部**模板产物（单模板重转码会复用现有 CEK，不换密钥，§4.2） | 该媒资短时维护窗口 |
| 播放会话 | 置 `revoked_at` | 新清单 / 密钥请求立即拒绝（≤60s 收敛）；已下载分片在 token exp 内仍可播（接受，ADR-0006 §6） |

### 4.5 相关环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `MASTER_KEYS` | 无（必填） | `"版本:64位hex"`，逗号分隔多版本。**轮换必须保留旧版本**（否则旧行无法解封，轮换会逐行失败并跳过）；未配置 / 非法时密钥接口报 500、页面顶栏提示（ADR-0006 §1） |
| `URL_SIGN_KEY_HEX` | 无（必填） | 分发端 URL 签名 HMAC 密钥；**仅用于鉴权签名，与 CEK 封装无关**，全站一套、不按媒资区分 |
| `EO_TYPEA_KEY` | 无 | EdgeOne URL 鉴权 TypeA 密钥（与 EO 控制台一致，ADR-0005） |

## 5. 转码执行（Worker，M2）

> 队列与状态机的原始决策在 ADR-0008；本节记录进入实现后的具体规则与不变量（与 ADR 冲突时以本节为准并回写 ADR）。

### 5.1 状态机与认领

- 任务状态：`QUEUED → PROBING → ENCODING → PACKAGING → DONE`；异常 → `FAILED`（取值与 Prisma `JobStatus` 逐字一致，`@openvod/contracts JOB_STATUSES`）；
- **认领用 CAS 条件更新**：候选 = `status ∈ {QUEUED,PROBING,ENCODING,PACKAGING}` 且（`lease_until` 为空或已过期）→ 条件更新为 `PROBING`、续 `lease_until`、`attempts+1`、写 `started_at`；`updateMany` 受影响行数 = 1 才算认领成功。MySQL 与 SQLite 语义一致，多实例并发下只有一个实例能拿到；ADR-0008 里的 MySQL `FOR UPDATE SKIP LOCKED` 作为**高并发演进项**（v1 不做方言分支）；
- 执行期按 `leaseMs/3` 心跳续期 → 长转码任务不会被重派；
- Worker 崩溃 → lease 过期 → 任务被重新认领（`attempts+1`）；`attempts` 超过 `WORKER_MAX_ATTEMPTS`（默认 3）→ 直接判 `FAILED`，防止崩溃循环；
- **同一媒资 + 同一模板同时只允许一个未终结任务**：管理端发起时校验（409）。产物按 `proceed/{id}/{templateId}/` 分树存放（§1.3），不同模板互不覆盖，故**同一媒资可并行不同模板的转码**；单次 submit 可多选模板，每个模板各入队一条任务。
- **同一媒资的任务串行执行**：Worker 每轮只认领并执行一个任务，单实例下同媒资不同模板任务天然串行。加密任务对同一媒资**必须**串行——否则两个任务各自 `generateMediaKey` 会产出两把不同的 CEK，只有最后落库的一把能解密，另一套产物永久不可解（ADR-0006 §4.2 密钥唯一约束）。v1 单 worker 实例（`start.sh`）满足此约束；多实例横向扩展属演进项（认领时需做媒资级串行）；
- **停止 / 重启（管理端「转码任务」页操作，M3）**：
  - **停止（取消）** = 置 `FAILED`（`last_error=已手动停止（管理端）`）+ 清租约。仅对 **QUEUED**（撤下队列，不再被认领）或**租约已过期**的执行中任务（worker 失联 / 已死，安全终止）开放；**租约有效（worker 正在执行）拒绝**——任务状态会被 worker 覆盖，执行中的中途取消需要 worker 侧检查点配合（演进项）。写入用 CAS（`where status = 原状态`），与 worker 的完成写竞态时返回 409 让用户刷新；
  - **重启（重新入队）** = 仅 **FAILED**（失败或手动停止）→ `QUEUED`，且 `attempts` **清零**（不清零会被认领逻辑立即判「超过重试上限」，worker `job-store.claim`）+ 清 `last_error` / 租约 / `started_at` / `finished_at`；
  - 两者均落 `audit_logs`（`transcode.stop` / `transcode.restart`），并 poke 任务页 SSE 立即推送新状态；
  - 任务 DTO 携带 `lease_active`（分发端是否持有有效租约），前端据此渲染「停止 / 重启」可用性与「中断」提示。

### 5.2 执行顺序（顺序即正确性）

1. 产物先落本地 `{os.tmpdir()}/openvod-jobs/{jobId}/out/`（`{variant}/index.m3u8` + `{variant}/seg-%05d.ts`，主清单 `master.m3u8`），**全部成功后再整体上传到 `proceed/{id}/{templateId}/`**；
2. 上传完成后**才**落 `hls_keys`——且仅在密钥是**新生成**时（复用已有 CEK 不写库，§4.2）；提前落库会让一次失败的转码换掉旧密钥，使既有密文无法解密；
3. 上传成功后清理**本模板子树** `proceed/{id}/{templateId}/` 下**本次未产出**的对象（旧档位 / 旧分片），避免新旧混播；清理发生在上传之后，因此失败不会先毁掉旧产物，也**不会碰到同一媒资其它模板的产物**；
4. 任意路径（成功 / 失败 / 取消）都要删除任务临时目录——其中含明文 CEK 与 `key_info`。

### 5.3 失败时的媒资状态

- 该媒资此前已是 `READY` → **保持 `READY`**：旧产物仍在且可播，不误报失败（此时只有 `job.last_error` 变化）；
- 否则 → `FAILED`；
- 失败原因写 `transcode_jobs.last_error`（管理端「转码任务」页展示，支持重派）。

### 5.4 档位判定与全档跳过兜底（2026-09-18 修订）

判定发生在 Worker 探测之后，以 `media.probe` 实测参数为唯一事实来源；判定维度为 **分辨率 / 帧率 / 码率**（intent.md「转码模板管理」规则 1–4）：

- **只降不升、高位取源**：低于源的维度按模板执行（缩放 / `-r` 降帧率 / `-b:v` 降码率）；**不低于源的维度一律取源值**——不写 `scale` 滤镜、不写 `-r`、`-b:v` 取源码率，即分辨率 / 帧率可「保持原视频」；
- **跳过**：三维度全部不低于源 → 该档跳过（保留 `skipReason` 供日志追溯，不产 argv，不占变体目录名）；
- **全档跳过兜底**：某模板**全部档位**均被判跳过时，Worker 追加一档**源规格兜底**（`compileSourceMatched`）——编码器 / preset / CRF / 加密按模板，分辨率 / 帧率 / 码率保持原视频；任务不再以「所有档位均被跳过」失败，必有产物（`ExecuteJobResult.sourceFallback = true` 供日志与排查）；
- **码率比较口径**：源码率优先取视频轨 `probe.video.bitrate`，缺失回退容器总码率；源码率未知或模板为 CRF 模式（无目标码率）时码率维度不参与降级判定（按模板原值编码）；
- 自适应档：源已在约束内 → 分辨率维度取源值，是否执行由三维度合并判定（open-questions #18 已收敛）；
- 兜底档的变体目录名按源输出高度命名（如 `1080p`），与主清单 `RESOLUTION` 一致。

### 5.5 产物布局与清单

- 上传后的键与 §1.3 布局一一对应：`proceed/{id}/{templateId}/master.m3u8`、`.../{variant}/index.m3u8`、`.../{variant}/seg-*.ts`（`templateId` 取任务快照的 `template_id`，缺失时回退任务记录的 `template_id`，都没有则任务直接失败）；Content-Type：`.m3u8` = `application/vnd.apple.mpegurl`，`.ts` = `video/mp2t`；
- 变体目录名按**实际输出高度**命名（如 `1080p` / `150p`，同名追加序号）；`keep_original`（只加密流程）单档同规则；
- 主清单 `BANDWIDTH`：模板声明了目标码率则用之（经三维度归一化，不高于源码率；见 §5.4）；CRF 模式与只加密流程按高度粗估（仅影响播放器起播选档提示，不影响编码）；
- 加密档位的子清单里 `EXT-X-KEY` 的 URI 是转码期**占位**，分发端改写清单时整体替换为带签名 token 的密钥 URL（ADR-0006 §3）。

### 5.6 Worker 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `WORKER_POLL_INTERVAL_MS` | `2000` | 轮询间隔（毫秒） |
| `WORKER_LEASE_MS` | `60000` | 任务 lease 时长（执行期按 1/3 续期） |
| `WORKER_MAX_ATTEMPTS` | `3` | 单任务最大尝试次数 |

## 6. 播放链路（分发端，M3）

> 决策源 ADR-0006（加密与密钥下发）/ ADR-0010（API 面）；本节记录实现细节与 M3 落地范围。与 ADR 冲突时以本节为准并回写 ADR。

### 6.1 端点与 token 传递

| 端点 | 鉴权 | 说明 |
|---|---|---|
| `POST /v1/auth/login` | 凭据 | bcrypt 校验 `users`（须 `status=ACTIVE`）→ ES256 JWT（`kid` / `exp=DELIVERY_JWT_TTL_SEC`；未配置签名密钥时 503） |
| `GET /v1/media` | JWT | 上架列表（`status=READY`；`limit` ≤200，默认 50；`poster_url` s3 形态为预签名） |
| `GET /v1/media/{id}` | JWT | 详情：probe 摘要（契约 `Probe` 子集）+ 就绪字幕轨道 + `playable` |
| `POST /v1/media/{id}/play` | JWT | 建 / 复用播放会话：`template_id` 可选（见 §6.3）；同用户同媒资未过期末吊销会话**默认复用**（幂等），`force_new=true` 强制新建；并发上限命中 → 409 `session_limit`；媒资非 READY → 409 `not_playable`；返回 `{sid, manifest_url, expires_at, template_id}` |
| `GET /v1/media/{id}/manifest/master.m3u8` | token(m) | 改写主清单：变体行替换为分发端 URL（typ=m + `tpl`）；`no-store` |
| `GET /v1/media/{id}/manifest/{variant}/index.m3u8` | token(m) | 改写子清单：`EXT-X-KEY` URI → key 接口（typ=k）；分片行 → typ=s / 预签名；`no-store` |
| `GET /v1/media/{id}/key` | token(k) | **16B CEK**（`application/octet-stream`，`no-store`）：验签 + 会话有效 → 按 `hls_keys.mk_ver` 取 MK 解封 |
| `GET /v1/media/{id}/local/{tpl}/{variant}/{seg}` | token(s) | **local 驱动**分片流式输出（支持 Range）；s3 驱动分片为预签名直出，不走此处 |
| `GET /v1/media/{id}/subtitles/{trackId}.vtt` | token(v) | M4（ADR-0009），当前 501 |

**token 传递（用户定，2026-09-18）**：URL query `t` 优先，其次请求头 `X-Playback-Token`（App / hls.js 可带自定义头；**Safari 原生 HLS 的密钥与分片请求无法带头**，因此 query 是必须形态）。token 自包含（`ver|typ|mid|sid|exp|kid`，HMAC-SHA256），`typ` 作用域 `m 清单 / s 分片 / k 密钥 / v 字幕`，`mid` 绑定防跨媒资重放，`sid` 绑定会话可吊销。

### 6.2 解密链路（一次播放的顺序）

1. `login` 取 JWT（业务 API 用；**不用于清单 / 密钥 / 分片**）；
2. `play` 建会话并返回签名主清单 URL；
3. 拉主清单 → 子清单（`tpl` + typ=m token）；
4. 子清单里 `#EXT-X-KEY` 的 URI 已被改写为 `/v1/media/{id}/key?t=<typ=k>`（`METHOD` / 显式 `IV` 原样保留）；分片行改写为 typ=s 分发端 URL（local）或**预签名直出 URL**（s3，字节不经过函数）；
5. 播放器自动 GET key → 验签 + 会话有效 → **MK 解封 `wrapped_cek`** → 返回 16B CEK（`no-store`，绝不缓存）；
6. 播放器用 CEK + 清单显式 IV 本地 AES-128-CBC 解密分片——Safari 原生 HLS / hls.js / ExoPlayer 均原生支持，**业务侧零解密代码**。

吊销语义：会话有效性**每请求查库**（比 ADR-0006 §6 的 ≤60s 收敛更严格；进程内 60s 缓存为演进项）——置 `revoked_at` 后新的清单 / 密钥 / 分片请求立即 403。

### 6.3 模板产物选择（多套并存，ADR-0014）

`play` 的 `template_id`（可选）：

- 显式指定 → 必须存在，否则 409 `not_playable`（消息列出可选值）；
- 未指定 → 唯一产物直接使用；多套 → 取**默认模板**（`transcode_templates.is_default`）的那套；仍无法唯一确定 → 409 `not_playable` 列出可选值；
- 无模板子树 → 旧布局（`proceed/{id}/{variant}/`），返回 `template_id=""`。

### 6.4 签名密钥材料形态与引导

- `signing_keys.private_enc`（JWT）＝ `hex(MK(AES-256-GCM)(P-256 标量 32B))`；`public_jwk` 存公钥 JWK。
  用标量而非 PKCS#8 DER：该列是 `VARCHAR(191)`，DER 的 hex（276 字符）会触发 P2000；
- 生成 / 轮换：`bun apps/admin/scripts/bootstrap-playback.ts <username> <password≥8位> [显示名] [--rotate-jwt-key]`
  —— 幂等：生成 JWT 签名密钥（轮换时旧 key 置 `RETIRING`，双 kid 宽限）并创建 / 重置播放端用户（bcrypt cost 12）；
- 分发端启动时把 ACTIVE 的 JWT 私钥全部解封加载（`signing_keys` 无 `mk_ver` 列 → 按 MK 版本逐个尝试解封，版本号大者优先）；无可用密钥不致命，login 返回 503。

### 6.5 相关环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `DELIVERY_DATABASE_URL` | 无（必填） | 分发端受限账号（ADR-0011：只读约定表 + `playback_sessions` 读写）。支持 `mysql://user:pw@host:port/db` 或 go-sql-driver DSN；**本地调试需指向可达库**（仓库 `.env` 里的 127.0.0.1 是占位） |
| `DELIVERY_PUBLIC_BASE_URL` | 空 → `http://127.0.0.1:{端口}` | 资源 URL 基址（拼清单 / 密钥 / 本地分片 URL）；生产填分发域名 / CDN 域名 |
| `URL_SIGN_KEY_KID` | `urlsign-v1` | 播放 token 的 `kid`（多 kid 宽限轮换为演进项） |
| `DELIVERY_JWT_ISSUER` | `openvod-delivery` | JWT `iss` |
| `DELIVERY_JWT_TTL_SEC` | `86400` | JWT 有效期（ADR-0007：默认 24h，无 refresh） |
| `PLAYBACK_SESSION_TTL_SEC` | `14400` | 播放会话有效期 |
| `PLAYBACK_MANIFEST_TTL_SEC` | `14400` | 清单 token / 预签名有效期上限（token exp ≤ 会话 exp） |
| `STORAGE_DRIVER` / `STORAGE_ROOT_PREFIX` / `STORAGE_LOCAL_ROOT` / `S3_*` | 对齐管理端 | 与 `packages/storage` 同源命名（§1.5） |
| `DELIVERY_CORS_ORIGINS` | `*` | 允许跨域读取清单 / 密钥 / 分片（管理端「产物解密播放」的 hls.js 需要）；播放鉴权全走 URL token、不带 Cookie，`*` 不引入凭证泄露面，可收敛为管理端源站（逗号分隔） |

### 6.6 M3 已落地范围外（演进项）

- **CDN + EdgeOne TypeA 分片鉴权**：当前 s3 形态用预签名直出（私有桶，字节不经过函数）；配置 CDN 基址后按 ADR-0005 接 TypeA（含 `signing_keys.kind=EO_TYPEA` 的读取与轮换双密钥窗口）；
- 登录 / play **限频**（ADR-0010）；严格模式（key 一次性 nonce、IP / UA 绑定、并发上限的踢下线，ADR-0006 §7 默认关）；
- 会话吊销的进程内 60s 缓存（当前每请求查库，语义更严格、量级可接受）；
- SQLite 自托管驱动（当前 Go 侧仅 MySQL；ADR-0004 的单机同卷形态待补）；
- `poster_url` 的 local 直出与 `custom_data` **公开白名单**（当前返回空对象，避免泄露内部字段）；
- 字幕链路（M4）。

**部署前置（非未完成项）**：管理端「产物 → 播放」由浏览器直连对象存储拉分片（s3 形态），要求**对象桶 CORS 放行管理端源站**（与封面截帧同一前提，§2.3）——未配置时表现为「有总时长但一直转圈」（分片请求被浏览器拦截），播放弹窗会在等待超时后给出该提示；`local` 形态分片经分发端流式输出（已带 CORS 头），无需桶配置。播放器为 Video.js v10（与媒资预览同一皮肤），HLS 由 `@videojs/hlsjs-video`（hls.js / MSE）承载，Safari 由 Video.js 自行回退原生 HLS。
