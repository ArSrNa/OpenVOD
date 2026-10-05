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
| `proceed/` | 转码与处理产物：HLS 主/子清单、分片、字幕等 | Worker / 管理端 | 分发端（预签名直出）、管理端 |
| `cover/` | 封面与图片资产（poster、缩略图等） | Worker / 管理端 | 分发端、管理端 |
| `metadata/` | 元数据：ffprobe 结果、业务扩展元数据（自定义元数据投影 `custom.json`，§8.3） | 管理端 / Worker | 管理端 / 分发端 |
| `watermark/` | 水印图片（按水印模板 ID 组织，§10.2） | 管理端 | Worker（转码烧录） |

- P0 纪律不变：**密钥材料绝不入对象存储**（wrapped CEK、JWT 私钥仅入数据库，ADR-0006）；
- 原视频与转码产物分区分开的动机：`original/` 只增不改（审计友好、误删可恢复），产物可随时按 ladder 重转并整体重建；
- `watermark/` 是**平台级模板资产**分区：按水印模板 ID（cuid）组织，不按媒资 ID 索引，不属于任何媒资的资产集合（§10.2）。

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
{root}/proceed/{id}/subtitles/{trackId}.vtt                 # 字幕（保留段；trackId = 轨道唯一 ID，规则见 §7）
{root}/cover/{id}/poster.jpg                                # 海报 / 封面图
{root}/metadata/{id}/probe.json                             # ffprobe 系统元数据
{root}/metadata/{id}/custom.json                            # 业务扩展元数据（自定义元数据投影，§8.3）
```

`watermark/` 分区**不参与媒资 ID 索引**：水印图片按**水印模板 ID** 组织（`{root}/watermark/{templateId}.{ext}`，规则见 §10.2），是平台级模板资产而非媒资产物——媒资删除与重转码都不触碰该分区。

`proceed/` 的**两级分组**（2026-09-18 定，M2 落地）：

- 第一级是媒资 ID，第二级是**模板 ID**（即 `transcode_templates.id`，cuid）：目录名就是模板 ID，所以「这份产物是哪个模板转出来的」可以直接从存储键读出；
- 同一媒资**允许多套模板产物并存**（如「原画加密」与「1080p 加密」各一套），互不覆盖；重转某个模板只替换 / 清理**该模板子树**（§5.2）；
- 单次发起转码可**多选模板**（§2.1）：每个模板各入队一条任务、各落一个 `proceed/{id}/{templateId}/` 子树，一次提交即可同时产出多套互不覆盖的产物；
- `proceed/{id}/subtitles/` 是**保留段**：字幕不属于模板产物，不参与模板分组。模板 ID 为 cuid 形状（`TEMPLATE_ID_PATTERN = /^c[a-z0-9]{20,}$/`），与保留段不会冲突；字幕文件名 `{trackId}` 即轨道唯一 ID（= `media_subtitles.id`，服务端生成），权威规则见 §7；
- **旧布局兼容**：M2 之前的产物落在 `proceed/{id}/{variant}/…`（无模板段），列举时归入空模板 ID 并展示为「未分组（旧布局）」；对该媒资重转码一次即可迁到新布局。

### 1.4 媒资列举规则（管理端「媒资列表」）

- **媒资集合以 `original/` 分区为准**：每个 `original/{id}.{ext}` 对象即一个媒资，`id` = 文件名去扩展名；
- `id` 必须为纯数字（`MEDIA_ID_PATTERN`）；非数字文件名或更深层级的对象不属于媒资，列举时忽略；
- 其余三个分区**只按 id 归组补充资产状态**（各分区下该 id 的对象数量），不反向定义媒资；`watermark/` 不参与媒资列举（不按媒资 ID 组织，§10.2），媒资列表 API 不扫描该分区；
- `proceed/` 额外按「媒资 → 模板」归组为 `products[]`（M2 实现）：每项给出 `template_id`、`template_name`（查 `transcode_templates`，模板已删为 `null`）、`objects`（对象数）、`bytes`（体积）、`variants[]`（变体目录名，如 `1080p` / `720p`）——列表与详情都用它回答「这份产物是哪个模板转的」；`proceed/{id}/subtitles/` 等保留段不参与分组；
- 管理端 `GET /api/admin/media` 一次列举四个分区并按 id 内存聚合返回（每条另附 `subtitleCount` = `proceed/{id}/subtitles/*.vtt` 对象数，供字幕管理页选择器使用）；v1 全量列举即可，分页 / 前缀裁剪留待媒资规模需要时再加；
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

> **端到端接口清单**（全部端点的方法 / 请求 / 响应 / 错误码 / 示例，含 2026-09-24 新增的分类与自定义元数据）
> 见 [api.md](./api.md)；本节记录规范语义与实现细节。

### 2.1 已实现（M1 媒资 / M2 转码 / M3 播放产物 / M4 字幕 / 用户 / 密钥，2026-09-20）

| 端点 | 方法 | 说明 |
|---|---|---|
| `/api/admin/media` | GET | 媒资列表（§1.4 存储视角 + DB 展示名/状态合并）；每条含 `products[]`——按模板分组的转码产物（模板名 / 对象数 / 体积 / 变体），旧布局产物归入 `template_id=""`；另含 `subtitleCount`（该媒资字幕对象数，§7.2）与 `category`（分类引用含路径）/ `description` / `tags`（自定义元数据，§8.3） |
| `/api/admin/media/upload` | POST | 原视频上传（§1.3）：生成数字 ID（主键冲突即重取）→ 流式写 `original/{id}.{ext}` → `media` 行落库；存储失败回滚 DB 行；**上传完毕后异步自动生成元数据**（2026-09-30 增：与 `/{id}/metadata` 同源，ffprobe → `metadata/{id}/probe.json` + `media.probe` / `duration_ms`）——响应立即返回 `metadata.status="pending"`，探测在响应发送后由后台任务执行（Next `after()`）；**best-effort**：失败只告警（上传仍成功，可手动重跑），管理端以递增间隔轮询详情直至 `probe` 就绪。**2026-10-01 增**：上传入口为独立上传页 + 客户端上传队列（§9）——客户端并发上限 2、取消 = 中止请求（服务端按「存储写入失败」回滚占位行）；端点、协议与并发语义本身不变 |
| `/api/admin/media/{id}` | GET | 详情：存储资产计数 + DB 元数据合并 + `products[]`（每套模板产物的模板名 / 变体 / 对象数 / 体积，模板 ID 可追溯到 `proceed/{id}/{模板id}/`）+ `custom`（自定义元数据**恒三项**：分类含 `id/name/path` / 描述 / 标签，§8.3）+ `customData`（稀疏投影原文） |
| `/api/admin/media/{id}` | PATCH | 媒资字段部分更新（`contracts UpdateMediaRequest`）：`title` = 重命名（仅改 `media.title`，绝不改动 original 文件名与媒资 ID）；`description` / `tags` / `category_id` = 自定义元数据设置（§8.2：服务端重算 `custom_data` 投影并导出 `metadata/{id}/custom.json`；**`category_id: null` = 归入默认分类「其他」**）；`uploaded_at` = 自定义上传时间（**2026-09-30 增**，ISO 8601，`null` = 恢复默认：管理端「上传时间」展示与分发端列表排序回退链使用，**不进入**元数据投影 / 分发端下发）；至少一个字段，否则 400。审计 `media.rename` / `media.metadata_update` / `media.uploaded_at_update` |
| `/api/admin/categories` | GET | 分类扁平列表（§8.1）：`id` / `name` / `description` / `parent_id`（层级由它表达，客户端组树）/ `sort_order` / `is_system`（系统默认分类「其他」= true，前端禁用删除）/ `media_count`（直属，含未设置分类的历史媒资计入「其他」）/ `descendant_media_count`（含子孙；**保留字段，当前 UI 不展示**）/ 时间戳；**默认分类缺失时幂等补建** |
| `/api/admin/categories` | POST | 新建分类（§8.1）：`name` 必填（≤64）、`description`（≤191）、`parent_id`（缺省 / `null` = 顶级，不限层级）、`sort_order`；上级不存在 404；**同级重名 409**（顶级重名也拦，DB 唯一索引对 NULL 不生效）；审计 `category.create` |
| `/api/admin/categories/{id}` | PATCH | 更新分类：改名 / 描述 / 移动（`parent_id`，禁止环路 → 409）/ 排序；上级不存在 404；同级重名 409；**改名或移动后刷新该分类子树下全部媒资的自定义元数据投影**（`path` 快照，§8.3），响应 `refreshed_media` 回报刷新条数；审计 `category.update` |
| `/api/admin/categories/{id}` | DELETE | 删除分类：**系统默认分类「其他」→ 409**（不可删除）；有子分类 → 409（先删 / 先移走）；该分类下的媒资**迁入默认分类「其他」**（不删媒资），删除后刷新这些媒资的投影（分类快照换成「其他」），响应 `affected_media` / `moved_to` / `refreshed_media`；审计 `category.delete` |
| `/api/admin/media/{id}` | DELETE | 删除：original 对象 + proceed/cover/metadata 三分区该 id 全部对象 + DB 行（级联 subtitles / transcode_jobs / hls_keys / playback_sessions）；幂等可重试。**级联范围说明**：open-questions #13 决议（软删 + 保留期 GC）之前的 v1 临时策略为**硬删除全级联** |
| `/api/admin/media/{id}/original` | GET | 原视频预览：预签名 GET 302 重定向（字节不经管理端；配置 `STORAGE_CDN_BASE_URL` 时 302 目标 origin 替换为加速域名，ADR-0005）；no-store |
| `/api/admin/media/{id}/cover` | POST | 上传封面：`cover/{id}/poster.{ext}`（jpg/png/webp/gif/avif）+ 回写 `media.poster_key`；手动上传 / 视频截帧双模式共用此端点（§2.3） |
| `/api/admin/media/{id}/cover` | GET | 封面图片读取（列表首列缩略图 / 详情展示，§3.1）：local 整对象流式输出；s3 预签名 GET 302（字节不经管理端，`STORAGE_CDN_BASE_URL` origin 替换同 original）；no-store |
| `/api/admin/media/{id}/metadata` | POST | 生成元数据：ffprobe 探测 original（local 直读文件路径 / s3 预签名 GET URL 供流）→ 原始输出落 `metadata/{id}/probe.json`，归一化摘要（宽高 / 帧率 / 色彩空间 / 编码 / 码率 / 音轨等，`@openvod/transcode summarizeProbe`）回写 `media.probe` + `media.duration_ms`；幂等覆盖式更新；落 `audit_logs`（`media.metadata_generate`）。要求运行环境安装 ffprobe。**2026-09-30 起上传完毕后由 upload 接口异步自动触发**（Next `after()` 于响应发送后执行，与 upload 同源逻辑；best-effort 降级不阻塞上传），本端点保留给手动重跑 |
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
| `/api/admin/stats` | GET | 控制台总览七项真实统计：`media`（`total` 为 `original/` 下去重媒资 ID 数、`ready` 为已入库且 READY、`not_ingested` 为无 DB 行）、`jobs`（QUEUED / PROBING / ENCODING / PACKAGING + `active`）、`users`（`total/active/disabled`）；`storage.used_bytes` 为当前 root 五分区（`original/proceed/cover/metadata/watermark`）对象大小总和（含分片 / 字幕 / 封面 / 水印图片 / 未入库文件，不含桶内其它业务前缀；`watermark/` 为 2026-10-02 水印管理新增）；`subtitles`（实际 VTT 文件 `total` / 覆盖 `media_count`）；`products`（按媒资 × 模板归组的 `total` / 覆盖 `media_count`，兼容旧布局并排除字幕）；`metadata`（数字媒资目录下对象 `total/probe/custom/other`，`probe.json` / `custom.json` 单独计数）。五分区各列举一次、自动遍历 S3 分页，目录占位不计文件；媒资复用原视频列表 + 两次 DB COUNT，任务四次 COUNT，用户两次 COUNT。契约为 `DashboardStatsResponse`（仅管理端，不生成 Go）；列举失败返回错误，不返回部分用量。首页只显示已用空间，不展示配额 / 百分比 / 分区进度条 / 活跃播放会话 |
| `/api/admin/users` | GET | 播放端用户列表（ADR-0004 `users` 表；ADR-0007 账户域，创建时间倒序）：用户名 / 展示名 / 状态 / 并发上限 / 进行中会话数 / 最近登录 / 注册时间。**响应不含 `password_hash`**（契约层不定义该字段，管理端无查看口令哈希的入口）。「进行中会话数」= `playback_sessions` 中未吊销且未过期的条数（批量 groupBy 一次统计） |
| `/api/admin/users` | POST | 新建播放端用户：`username` + `password`（后者 bcrypt cost 12 摘要后入库，ADR-0007）→ 默认 `ACTIVE`；可选 `display_name` / `max_concurrent_sessions`。用户名重复 409；用户名或口令不合法 400。落 `audit_logs`（`user.create`） |
| `/api/admin/users/{id}` | GET | 用户详情：DTO + 进行中会话数（404 若用户不存在） |
| `/api/admin/users/{id}` | PATCH | 更新展示名 / 状态 / 并发上限（**用户名创建后不可修改**——口令与用户名变更分别走重置密码 / 新建+删除）。**封禁（ACTIVE → DISABLED）立即吊销该用户全部未过期会话**（ADR-0007：封禁 → 登录拒绝 + 全会话吊销），吊销条数随响应 `revoked_sessions` 返回；重复封禁 / 解除封禁不触发吊销。落 `audit_logs`（`user.update`，detail 含 `revoked_sessions`） |
| `/api/admin/users/{id}/password` | POST | 重置口令（`password`，bcrypt cost 12）：凭据变更后同样**立即吊销该用户全部未过期会话**（否则已下发 JWT 在 exp 前仍可播放），`revoked_sessions` 随响应返回。落 `audit_logs`（`user.password_reset`） |
| `/api/admin/users/{id}/revoke-sessions` | POST | 手动吊销该用户全部未过期会话（用户仍为 `ACTIVE`，可重新登录），返回 `revoked_sessions`。落 `audit_logs`（`user.sessions_revoke`） |
| `/api/admin/users/{id}` | DELETE | 删除用户：`playback_sessions` 随用户级联删除（Prisma `onDelete: Cascade`，等价于全会话吊销），响应用级联条数回报。落 `audit_logs`（`user.delete`） |
| `/api/admin/media/{id}/subtitles` | GET | 字幕轨道列表（§7.4）：trackId / `lang`（BCP-47，归一化后）/ `label` / `is_default` / `status` / `bytes` / `storage_key` / 时间戳 + `storage_ok`（对象存在性，存储不可用为 null）；顺序 `is_default DESC, created_at ASC`；媒资未入库 404 |
| `/api/admin/media/{id}/subtitles` | POST | 新建字幕轨道（§7.4）：查询参数 `lang`（必填，兼容 `zh_CN` 写法、服务端归一化为 `zh-CN`）/ `label`（必填 1–64）/ `is_default`（可选）；请求体为**原始字幕字节流**（octet-stream：`.vtt` 直接用，`.srt` 自动转 VTT，§7.3）→ 结构化校验（UTF-8 / `WEBVTT` 头 / cue 时间轴，§7.3）→ 生成 trackId → 写 `proceed/{id}/subtitles/{trackId}.vtt` → 落 `media_subtitles`（`status=READY`、`created_by`=管理端账号）→ 审计 `subtitle.create`；同媒资同语言 409（DB 唯一约束 `(media_id, lang)`）；首条自动成为默认轨；校验失败 400 且不落库不落存储 |
| `/api/admin/media/{id}/subtitles/{trackId}` | PATCH | 更新轨道元信息（`label` / `lang` / `is_default`）：`lang` 走同一归一化与唯一校验（409）；`is_default=true` 在事务内清除该媒资其它默认轨；审计 `subtitle.update` |
| `/api/admin/media/{id}/subtitles/{trackId}/content` | GET | 读取该轨道 WebVTT（管理端「字幕预览」用：original 原视频 + 该轨字幕，同源 `<track>` 引用）：两种驱动均由管理端代理输出 `text/vtt; charset=utf-8` + `no-store`；轨道或对象缺失 404 |
| `/api/admin/media/{id}/subtitles/{trackId}/content` | PUT | 覆盖字幕文本（原始字幕字节流：`.vtt` / `.srt`（自动转 VTT），同一校验）：**就地覆盖同一对象**（trackId / 存储键不变）→ 更新 `bytes` / `updated_at`；审计 `subtitle.update`（detail 含 `content_replaced`） |
| `/api/admin/media/{id}/subtitles/{trackId}/content` | GET | 读取该轨道 WebVTT（**字幕预览**用，§7.6）：以行内 `storage_key` 读对象，两种驱动均由管理端代理输出（≤5MiB）+ `text/vtt; charset=utf-8` + `no-store`；轨道或对象缺失 404 |
| `/api/admin/media/{id}/subtitles/{trackId}` | DELETE | 删除轨道：先删存储对象、再删 DB 行（幂等可重试）；删默认轨不自动改派；审计 `subtitle.delete` |
| `/api/admin/settings` | GET / PUT | 按 `group=playback/storage/security/worker` 读写设置、来源与版本。PUT `{group, revision, values}` 仅更新提交键，空串清除覆盖，密钥 MK 封装且不回显；校验、写入、审计同一事务，版本冲突 409。兼容原单字段播放域名请求。详见 §2.1.2 |

### 2.1.1 播放端用户（ADR-0004 / ADR-0007）

- 用户表由管理端全量 CRUD，分发端 login 只读校验（`status=ACTIVE` 才允许登录）；已下发分片 token 在自身 `exp` 内仍有效（ADR-0006 已声明接受），吊销只影响新请求；
- 口令只写不读：接口入参只接受明文口令并即时 bcrypt 摘要，响应与契约**均无口令 / 哈希字段**；`max_concurrent_sessions` 为 `0` 表示不限制（ADR-0007）；
- 管理端用户（`admin_users` + better-auth Cookie 会话）与播放端用户（`users` + ES256 JWT）是两套体系，切勿混用。

### 2.1.2 系统设置（system_settings，2026-09-22 按 ADR-0015 修订）

继续使用现有 key-value 表，不新增配置表或配置文件。页面为 `/settings/playback`、`/settings/storage`、`/settings/security`、`/settings/worker`，分别承载播放策略/预览账号、S3 存储、安全/登录、Worker/新媒资 ID 参数；转码模板保持独立。

- **边界**：数据库连接、provider、端口与 MK 根密钥只能由 env 提供。其它登记项按 DB > env > 默认解析。S3 SK、URL 签名密钥、会话密钥、OIDC secret、预览口令仅以 MK 封装值落库。
- **API**：GET `?group=...` 返回 `{group, revision, fields, restart_required}`；每个 field 包含 `key/label/value/source/secret/configured/overridden`。密钥 `value=null`，不返回明文或密文。PUT `{group, revision, values}`；值为字符串，未提交键保持不变，空串删除覆盖并回退 env/默认。
- **校验**：仅允许本分组登记键，拒绝 `setup_completed`、MK 及未知字段；64 KiB 请求上限、单值 8192 字符上限；TTL 范围与 `manifest ≤ session`（包括回退值）；URL 不接受凭据/查询/片段；CORS 为 `*` 或标准来源列表；根前缀禁止路径逃逸。不能清空存储必需字段或登录/播放密钥而又没有 env 兜底。
- **并发与审计**：revision 为该分组已存行（包括 updatedAt）的摘要；在 Serializable 事务中校验版本、修改所有键并写 `settings.update`。冲突 409，校验失败 400，审计失败整批回滚。审计中的密钥值恒为 `[redacted]`。不提供历史版本/自动回滚功能。
- **鉴权**：管理员 Cookie 会话及初始化门禁；写请求检查当前管理端来源与 JSON Content-Type。管理端 HTTP 自注册关闭，`/setup` 和部署脚本的服务端建号仍可用。
- **生效**：Admin 本进程保存后清缓存，其余实例约 30s；认证配置变化按需重建 Better Auth，预览账号变化使 JWT 缓存失效。Worker 30s 缓存，在下一次空闲轮询读取，运行中任务继续使用已认领的配置。分发端约 60s 刷新并整体切换不可变服务配置，旧请求用旧配置结束，不改写正在处理的请求。
- **失败处理**：编辑页读取失败明确报错，不把回退值误报为已保存设置；Admin 与分发端运行期刷新失败保留最后有效配置，冷启动才使用 env 兜底或失败。Admin 保存后使用缓存代次阻止旧在途查询写回；清除覆盖前校验回退值。设置清除成功后正常回退 env/默认。
- **操作影响**：更换存储位置不迁移历史资产；更换 URL 签名密钥会使旧签名链接失效；更换管理端会话密钥可能要求重新登录。页面明确提示。

旧 GET 无 group 仍返回 `playback_base_url` 与 `env_public_base_url`；旧 PUT `{playback_base_url}` 通过同样的事务与审计流程兼容。分发端受限数据库账号需要 `system_settings` SELECT 权限。

`playback_manifest_ttl_sec` 同时用于对象预签名，设置上限为 7 天，对齐 [S3 SigV4 预签名有效期](https://docs.aws.amazon.com/AmazonS3/latest/userguide/using-presigned-url.html)。

### 2.2 未实现（501 占位，随里程碑落地）

§2.1 已列出的端点均已实现（M1~M4，含 §10 的水印端点与转码模板的 `watermark_id` 关联）；**未列出的路径**统一由 `/api/admin/[...path]` 返回 501 `not_implemented`（会话守卫仍然生效）。

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
- 跨域前置：预览为预签名 302 跳转，`<video>` 必须显式 `crossOrigin="anonymous"` 以 CORS 模式拉流（媒体元素默认 no-cors，即使桶已放行 CORS 画布仍会被污染、导出抛 SecurityError）；**要求对象桶 CORS 允许管理端源站**（AllowedOrigin 与页面源站含协议端口精确匹配、Method 含 GET 与 OPTIONS——Range 头触发预检、AllowedHeader 含 Range 或 `*`）；CORS 未放行时视频直接加载失败（onError 提示排查项并回退手动上传），不阻塞端点。

## 3. 管理端页面

### 3.0 表格滚动约定（2026-09-18 用户规定，所有管理相关表格强制）

- 所有管理相关表格**必须**「表体限高、内部纵向滚动、表头固定」，页面本身不随条目数增长；内容超长必须滚动，不得撑开页面；
- 超宽表格同时横向滚动（antd `scroll.x` = 各列宽合计）；
- 统一复用 `apps/admin/src/components/tableScroll.ts` 的 `useTableBodyHeight`（视口高度推算 + resize 重算 + 极窄视口兜底），**不得各自实现**；
- 已实现页面：`/media`（媒资列表）、`/media/upload`（视频上传，§9）、`/categories`（分类管理，树形表格）、`/templates`（转码模板）、`/watermarks`（水印管理）、`/subtitles`（字幕管理）、`/users`（播放端用户）、`/keys`（密钥）、`/jobs`（转码任务）；后续所有表格页面同样遵循。

### 3.1 已实现页面

- `/media`（媒资管理，M1/M2 已实现，M3 增产物操作，2026-09-24 增分类 / 标签）：媒资列表表格——**封面缩略图（首列，antd Image，经 GET `/cover` 读取，点击预览大图；未设置显示「未设置」）**、**展示名（第一行为展示名，第二行为媒资 ID 代码样式；右侧复制按钮一键复制 ID + 重命名按钮）**、生命周期状态、原始文件（格式 / 大小 / 上传时间——**可自定义**：设置后展示自定义值并带「自定义」Tag，未设置回退对象存储写入时间，2026-09-30 增）、**分类 / 标签（分类完整路径或「未分类」Tag；标签最多平铺 2 个 + 「+N」悬停全量，§8.5）**、**描述（视频描述列：媒资自身描述，空显示「—」，§8.5）**、**转码产物（按模板分组：`N 组产物 · M 个对象`，悬停列出每套产物的模板名与档位，点击打开产物列表）**；详情弹窗显示产物组数并提供「产物列表（播放 / 删除）」入口（不再逐套平铺）；
  - **产物列表（抽屉，按模板一行）**：模板名（已删显示「模板已删除（id 前缀）」；旧布局显示「未分组（旧布局）」）、存储前缀 `proceed/{id}/{模板id}/`、变体（`1080p / 720p`）、对象数、体积；操作：
    - **播放** = 解密播放预览（`POST /media/{id}/preview-play` → 分发端签名主清单 URL → hls.js / Safari 原生播放，浏览器本地解密；管理端不出密钥，§4.3），播放弹窗标注「AES-128 加密（浏览器本地解密）」或「未加密」与模板 ID；
    - **删除** = 按模板删除该套产物（`DELETE /media/{id}/products/{templateId}`；确认弹窗给出前缀 / 对象数 / 体积与不可恢复警告；同模板有进行中任务时 409，需等待其结束）；
  - 播放失败的常见排查提示直接展示在弹窗内：分发端 CORS（`DELIVERY_CORS_ORIGINS`）或对象桶 CORS 未放行管理端源站；预览账号未配置时接口 501（dev-workflow §5.3）；
- `/media/upload`（上传视频，2026-10-01 已实现；§9 权威）：拖拽区（多文件、`video/*`）+ **上传任务列表**（进度条 / 状态 / 媒资 ID / 失败原因；取消 / 重试 / 移除 / 清空已完成）；任务为**客户端队列**——页面切换不中断、并发 2、刷新即中断（有进行中任务时离开给原生确认提示）；右上角全局入口显示「x 个上传任务进行中」并跳转本页；媒资列表页「上传视频」按钮改为跳转本页。
- `/subtitles`（字幕管理，M4 已实现）：顶部可搜索媒资选择器（选项标注已有字幕条数，默认选中已有字幕的媒资）+ 该媒资的轨道面板（预览 / 上传 / 编辑 / 替换内容 / 删除，与媒资页抽屉同一组件）；规范见 §7.6。
- `/templates`（转码模板，ADR-0014 已实现，2026-10-05 增水印关联 §10）：模板列表表格——模板名（默认标记）、描述、模式（转码 / 保持原视频）、加密（AES-128）、格式（M3U8）、**水印（关联的水印模板名 Tag，未关联显示「无」；`keep_original` 恒为「无」——不重编码无法烧录）**、参数摘要（编码器 / 码率或 CRF / 分辨率档位 / 帧率 / preset）、更新时间；操作：新建 / 编辑（弹窗表单，含**水印下拉**（来自 `/api/admin/watermarks`，未上传图片的图片型水印置灰并标「待上传图片」；`keep_original` 时不渲染该字段并在说明里注明不可关联）、分辨率档位多行编辑：固定宽×高、自适应上限约束或**保持原分辨率**（2026-10-05 增，不缩放、仍重编码；是否执行由帧率 / 码率维度判定，§5.4））、删除（确认弹窗注明已发起任务不受影响）；API 见 §2（`/api/admin/templates`）。
- `/watermarks`（水印管理，2026-10-02 已实现，独立模块，§10 权威）：模板列表表格——预览缩略（图片型经 GET `/{id}/image`；文字型按字体 / 颜色渲染小样）、名称、类型（图片 / 文字 Tag）、参数摘要（锚点 / 偏移 / 透明度 / 混合 / 尺寸或字号）、**被引用数（`referenced_by`，>0 时删除按钮的确认文案给出具体数量与「先解除关联」）**、图片状态（图片型 `missing` 黄标「待上传」）、更新时间；操作：新建 / 编辑（弹窗：类型选择（创建后不可改）+ 公共参数 + 类型专属 + **浏览器侧实时预览**）、上传 / 替换图片、删除。
- `/users`（播放端用户，ADR-0004 `users` 表 / ADR-0007 账户域）：用户列表表格——用户名（加粗，已封禁标红 Tag）、展示名、状态（可用 / 封禁 Tag）、并发上限（`0` 悬停提示「0 = 不限制」）、进行中会话数、最近登录、注册时间；操作：新建 / 编辑（弹窗表单：用户名创建后为只读，口令仅新建时可填，状态用 Switch，并发上限 0–10000）、重置密码（独立弹窗，双口令确认，提示将吊销全部会话）、吊销会话（有会话时才可点）、封禁 / 启用、删除（确认弹窗区分「级联删除会话」与「封禁后可恢复」）。页面**不提供口令 / 哈希的查看与导出入口**；API 见 §2.1.1。
- `/keys`（密钥管理，已实现）：密钥列表表格——媒资 ID、展示名、媒资状态、kid（截断 + Tooltip 全量）、算法、MK 版本（非当前版本标「待轮换」）、加密产物对象数、生成时间；顶部条展示当前封装版本与各版本密钥用量；操作：详情（弹窗：kid / IV / mk_ver / 生成时间 / 使用中会话数，并明确标注「明文密钥不展示」）、删除（确认弹窗警告需重转码才能恢复可播）、「轮换 MK」（确认后重封装旧版本，无需重转码）；API 见 §2.1 与 §4.3。**页面不提供任何明文密钥的展示 / 导出入口**。
- `/jobs`（转码任务，M2 已实现，M3 增停止 / 重启）：任务列表表格——任务 ID、媒资（ID + 展示名）、状态（排队 / 探测中 / 转码中 / 封装上传中 / 完成 / 失败；worker 失联的执行中任务标「中断」）、模板名（取任务快照）、尝试次数、耗时、失败原因、创建时间；**操作列**：停止（取消）/ 重启（重新入队），规则见 §5.1；**实时推送（SSE）**——连接即回放全量快照，任务变化由服务端主动推送（客户端零轮询），断线自动重连并展示连接状态；「刷新」= 重建连接（服务端随即回放最新快照），「耗时」列由本地时钟每秒重算（不发请求）；**侧边栏「转码任务」菜单项 Badge**（2026-10-01 用户定）：存在进行中任务（`QUEUED / PROBING / ENCODING / PACKAGING`）时显示数量，与任务页同一 SSE 快照源，无进行中任务不渲染；API 见 §2.1（`/api/admin/jobs`、`/api/admin/jobs/stream`、`/api/admin/jobs/{id}/stop|restart`），执行规则见 §5。
- 操作（对应 §2.1）：上传视频（**2026-10-01 起改为跳转独立上传页 `/media/upload`（§9），本页不再内联文件选择与上传进度**；上传页负责多文件拖入 → 客户端队列（并发 2、切页不中断）→ 进度与任务状态展示，**上传完毕后异步自动生成元数据**在上传页的任务状态中体现——任务转入「元数据生成中」，按递增间隔轮询详情，就绪 → 完成，超时黄色告警提示可「更多 → 生成元数据」重跑，2026-09-30 增 / 2026-10-01 迁移）、预览（弹窗 `<video>` 播放 original，local 支持 Range 拖动）、详情（弹窗展示元数据：probe 摘要结构化展示——容器 / 分辨率 / 帧率 / 编码 / 像素格式 / 色彩空间 / 码率 / 音轨等 + 摘要 JSON 折叠块）、重命名（仅展示名）、删除（确认后硬删除全级联）、设置封面（弹窗双模式：手动上传 / 视频截帧，§2.3）、「更多 → 生成元数据」（ffprobe 探测，§2.1；2026-09-30 起上传完毕后**异步自动生成**，此处用于手动重跑）、「更多 → 转码」（M2 已实现：弹窗**多选**模板（默认勾选默认模板）→ 逐个展示所选模板的模式 / 加密 / 输出格式 → 一次发起入队多条 `transcode_jobs`（每个模板各一条、各落 `proceed/{id}/{模板id}/`），进度跳「转码任务」页查看）；「更多 → 字幕管理」打开**字幕管理抽屉**（M4 已实现：多轨 VTT 列表 / 上传 / 编辑元信息 / 替换文本 / 删除，语言按 BCP-47 归一化；规范见 §7.6）；「更多 → 分类、描述与标签」与详情弹窗的「编辑自定义元数据」打开**自定义元数据弹窗**（分类 TreeSelect 无限层级 + 视频描述 + 标签，§8.5）；「更多 → 修改上传时间」与详情弹窗「上传时间」旁的编辑按钮打开**上传时间弹窗**（`DatePicker showTime`；留空保存 = 恢复默认；2026-09-30 增）。
- `/categories`（分类管理，2026-09-24 已实现，独立模块）：**树形表格**（antd `children` 层级，默认展开全部父节点，遵循 §3.0 滚动约定）——分类名（系统默认分类「其他」带「默认」标记）、描述、直属媒资、排序、更新时间；操作：**新建子分类**（行内，预设上级）、**编辑**（弹窗：上级 TreeSelect（自身与子孙禁选，防环路）/ 分类名 / 描述 / 同级排序）、**删除**（Popconfirm 提示：直属媒资将归入默认分类「其他」、媒资不被删除；系统默认分类按钮禁用）；顶部「新建顶级分类」与「刷新」；规范见 §8.1 / §8.5。

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
| ~~`EO_TYPEA_KEY`~~ | 无 | **已废弃（2026-09-20，ADR-0005 修订）**：播放分片改用 S3 预签名直出，不再使用 EdgeOne TypeA |

## 5. 转码执行（Worker，M2）

> 队列与状态机的原始决策在 ADR-0008；本节记录进入实现后的具体规则与不变量（与 ADR 冲突时以本节为准并回写 ADR）。
> 转码模板可关联水印模板：水印烧录发生在**每档缩放之后、编码与切片之前**（滤镜链 / 快照 / 两层校验规则见 §10.4）。

### 5.1 状态机与认领

- 任务状态：`QUEUED → PROBING → ENCODING → PACKAGING → DONE`；异常 → `FAILED`（取值与 Prisma `JobStatus` 逐字一致，`@openvod/contracts JOB_STATUSES`）；
- **认领用 CAS 条件更新**：候选 = `status ∈ {QUEUED,PROBING,ENCODING,PACKAGING}` 且（`lease_until` 为空或已过期）→ 条件更新为 `PROBING`、续 `lease_until`、`attempts+1`、写 `started_at`；`updateMany` 受影响行数 = 1 才算认领成功。MySQL 与 SQLite 语义一致，多实例并发下只有一个实例能拿到；ADR-0008 里的 MySQL `FOR UPDATE SKIP LOCKED` 作为**高并发演进项**（v1 不做方言分支）；
- 执行期按 `leaseMs/3` 心跳续期 → 长转码任务不会被重派；
- Worker 崩溃 → lease 过期 → 任务被重新认领（`attempts+1`）；`attempts` 超过 `WORKER_MAX_ATTEMPTS`（默认 3）→ 直接判 `FAILED`，防止崩溃循环；
- **同一媒资 + 同一模板同时只允许一个未终结任务**：管理端发起时校验（409）。产物按 `proceed/{id}/{templateId}/` 分树存放（§1.3），不同模板互不覆盖，故**同一媒资可并行不同模板的转码**；单次 submit 可多选模板，每个模板各入队一条任务。
- **同一媒资的任务串行执行**：Worker 每轮只认领并执行一个任务，单实例下同媒资不同模板任务天然串行。加密任务对同一媒资**必须**串行——否则两个任务各自 `generateMediaKey` 会产出两把不同的 CEK，只有最后落库的一把能解密，另一套产物永久不可解（ADR-0006 §4.2 密钥唯一约束）。v1 单 worker 实例（`scripts/dev.ts` 启动）满足此约束；多实例横向扩展属演进项（认领时需做媒资级串行）；
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

### 5.4 档位判定与全档跳过兜底（2026-09-18 修订，2026-10-05 增保持原分辨率档）

判定发生在 Worker 探测之后，以 `media.probe` 实测参数为唯一事实来源；判定维度为 **分辨率 / 帧率 / 码率**（intent.md「转码模板管理」规则 1–5）：

- **只降不升、高位取源**：低于源的维度按模板执行（缩放 / `-r` 降帧率 / `-b:v` 降码率）；**不低于源的维度一律取源值**——不写 `scale` 滤镜、不写 `-r`、`-b:v` 取源码率，即分辨率 / 帧率可「保持原视频」；
- **跳过**：三维度全部不低于源 → 该档跳过（保留 `skipReason` 供日志追溯，不产 argv，不占变体目录名）；
- **全档跳过兜底**：某模板**全部档位**均被判跳过时，Worker 追加一档**源规格兜底**（`compileSourceMatched`）——编码器 / preset / CRF / 加密按模板，分辨率 / 帧率 / 码率保持原视频；任务不再以「所有档位均被跳过」失败，必有产物（`ExecuteJobResult.sourceFallback = true` 供日志与排查）；
- **码率比较口径**：源码率优先取视频轨 `probe.video.bitrate`，缺失回退容器总码率；源码率未知或模板为 CRF 模式（无目标码率）时码率维度不参与降级判定（按模板原值编码）；
- 自适应档：源已在约束内 → 分辨率维度取源值，是否执行由三维度合并判定（open-questions #18 已收敛）；
- **保持原分辨率档**（`{mode:"source"}`，2026-10-05 增）：分辨率维度恒取源值（不写 `scale` 滤镜，变体目录名按源输出高度），是否执行由帧率 / 码率维度判定——三维度均不低于源 → 该档跳过；仍重编码，与「保持原视频配置」（`-c copy` 不重编码）不是同一语义；
- 兜底档的变体目录名按源输出高度命名（如 `1080p`），与主清单 `RESOLUTION` 一致。

### 5.5 产物布局与清单

- 上传后的键与 §1.3 布局一一对应：`proceed/{id}/{templateId}/master.m3u8`、`.../{variant}/index.m3u8`、`.../{variant}/seg-*.ts`（`templateId` 取任务快照的 `template_id`，缺失时回退任务记录的 `template_id`，都没有则任务直接失败）；Content-Type：`.m3u8` = `application/vnd.apple.mpegurl`，`.ts` = `video/mp2t`；
- 变体目录名按**实际输出高度**命名（如 `1080p` / `150p`，同名追加序号）；`keep_original`（只加密流程）单档同规则；
- 主清单 `BANDWIDTH`：模板声明了目标码率则用之（经三维度归一化，不高于源码率；见 §5.4）；CRF 模式与只加密流程按高度粗估（仅影响播放器起播选档提示，不影响编码）；
- 加密档位的子清单里 `EXT-X-KEY` 的 URI 是转码期**占位**，分发端改写清单时整体替换为带签名 token 的密钥 URL（ADR-0006 §3）。

### 5.6 Worker 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `WORKER_MODE` | `resident` | 运行模式（ADR-0017）：`resident` = 常驻轮询；`http` = HTTP 门铃（`POST /wake` 触发 claim-drain，空闲可退出）。DB `worker_mode` > env |
| `WORKER_HTTP_PORT` | `9001` | http 模式监听端口（含 `GET /healthz`） |
| `WORKER_IDLE_EXIT_MINUTES` | `0`（不退出） | http 模式空闲退出阈值 |
| `WORKER_NOTIFY_SECRET` | 空（http 模式必填） | `/wake` Bearer 密钥；缺失拒绝启动 |
| `WORKER_POLL_INTERVAL_MS` | `2000` | 轮询间隔（毫秒，仅 resident 模式） |
| `WORKER_LEASE_MS` | `60000` | 任务 lease 时长（执行期按 1/3 续期） |
| `WORKER_MAX_ATTEMPTS` | `3` | 单任务最大尝试次数 |

http 模式下 admin 经 `worker_notify_url` / `worker_notify_secret`（system_settings，ADR-0015）在发起转码 / 重启后 fire-and-forget `POST {url}/wake` 加速认领；通知可丢，任务留存队列兜底。详见 ADR-0017 与 [env-vars.md](./env-vars.md)。

## 6. 播放链路（分发端，M3）

> 决策源 ADR-0006（加密与密钥下发）/ ADR-0010（API 面）；本节记录分发端（数据面）规范语义、实现细节与 M3 落地范围，与 ADR 冲突时以本节为准并回写 ADR。
> 端到端接口清单（每个端点的方法 / 鉴权 / 请求 / 响应字段 / 失败码 / 示例，含 `custom` 自定义元数据白名单）见 [api.md](./api.md) §2。

### 6.1 端点与 token 传递

| 端点 | 鉴权 | 说明 |
|---|---|---|
| `POST /v1/auth/login` | 凭据 | bcrypt 校验 `users`（须 `status=ACTIVE`）→ ES256 JWT（`kid` / `exp=DELIVERY_JWT_TTL_SEC`；未配置签名密钥时 503） |
| `GET /v1/media` | JWT | 上架列表（`status=READY`；`limit` ≤200，默认 50；排序 `COALESCE(published_at, uploaded_at, created_at) DESC, id DESC` —— 发布时间 → 自定义上传时间（2026-09-30 增）→ 入库时间；`poster_url` 为预签名直出） |
| `GET /v1/media/{id}` | JWT | 详情：probe 摘要（契约 `Probe` 子集）+ 就绪字幕轨道 + `playable` |
| `POST /v1/media/{id}/play` | JWT | 建 / 复用播放会话：`template_id` 可选（见 §6.3）；同用户同媒资未过期末吊销会话**默认复用**（幂等），`force_new=true` 强制新建；并发上限命中 → 409 `session_limit`；媒资非 READY → 409 `not_playable`；返回 `{sid, manifest_url, expires_at, template_id}`（M4 起附签名 `subtitles[]` 与每条轨道的 `url`，§7.5） |
| `GET /v1/media/{id}/manifest/master.m3u8` | token(m) | 改写主清单：变体行替换为分发端 URL（typ=m + `tpl`）；`no-store` |
| `GET /v1/media/{id}/manifest/*`（实际路径 `{variant}/index.m3u8`） | token(m) | 改写子清单（通配路由，可含子目录）：`EXT-X-KEY` URI → key 接口（typ=k）；分片行 → **S3 预签名直出 URL**（`typ=s` 不再签发）；`no-store` |
| `GET /v1/media/{id}/key` | token(k) | **16B CEK**（`application/octet-stream`，`no-store`）：验签 + 会话有效 → 按 `hls_keys.mk_ver` 取 MK 解封 |
| ~~`GET /v1/media/{id}/segment/{tpl}/{variant}/{seg}`~~ | — | **已取消**（ADR-0005 2026-09-22 修订：仅 S3，local 驱动分片流式输出移除）；分片一律预签名直出 |
| `GET /v1/media/{id}/subtitles/{trackId}.vtt` | token(v) | 字幕 VTT 输出（§7.5）：验签 + 会话有效 → 查轨道（`status=READY`）→ 按行内 `storage_key` 读对象，**由分发端代理输出**（≤5MiB）；`text/vtt; charset=utf-8` + `no-store` |

**token 传递（用户定，2026-09-18）**：URL query `t` 优先，其次请求头 `X-Playback-Token`（App / hls.js 可带自定义头；**Safari 原生 HLS 的密钥与分片请求无法带头**，因此 query 是必须形态）。token 自包含（`ver|typ|mid|sid|exp|kid`，HMAC-SHA256），`typ` 作用域 `m 清单 / s 分片 / k 密钥 / v 字幕`（`s` 为保留类型，v1 不再签发——分片走预签名直出），`mid` 绑定防跨媒资重放，`sid` 绑定会话可吊销。

**请求 / 响应字段（2026-09-23 按实现核对）**：

- `login`：请求 `{username, password}`；成功写 `users.last_login_at`，返回 `{access_token, token_type:"Bearer", expires_in, kid}`；
- `GET /v1/media`：`limit` 缺省 50、上限 200（非法 / 越界静默回退缺省值）；返回 `{items[], next_cursor}`，条目 = `{id, title, duration_ms, poster_url, custom}`，排序 `COALESCE(published_at, uploaded_at, created_at) DESC, id DESC`（发布时间 → 自定义上传时间 → 入库时间，2026-09-30 增中间级）；**cursor 分页未实现，`next_cursor` 恒为 `null`**（v1 只返回前 `limit` 条，ADR-0010 的 cursor 契约留待后续）；`custom` = 自定义元数据公开白名单（§8.4；无内容时为空对象）；
- `GET /v1/media/{id}`：`{id, title, status, playable, duration_ms, poster_url, probe, subtitles[], custom}`——`probe` 仅含宽 / 高 / 视频编码 / 音频编码 / 码率（未探测为 `null`）；`subtitles[]` = `{id, lang, label, is_default}`（`status=READY`，顺序 `is_default DESC, created_at ASC`，**不含 URL**）；`custom` 与列表同口径（公开白名单，§8.4；无内容时为空对象）；未入库 404（非 READY 仍返回详情，仅 `playable=false`）；
- `POST /v1/media/{id}/play`：请求体**可整体省略**（仅在 `Content-Length>0` 时解析）；返回 `{sid, manifest_url, expires_at, template_id, subtitles[]}`，`expires_at` 为 RFC3339 UTC（会话到期时间），`subtitles[].url` 各轨共用同一枚 typ=v token。

**请求体与错误信封**：请求体上限 64 KiB，超限 / 非法 JSON / 空体 → 400 `bad_request`；错误响应统一 `{ "error": { "code", "message" } }`（HTTP 状态与 `code` 双通道）。

| code | HTTP | 触发场景 |
|---|---|---|
| `bad_request` | 400 | 登录 / play 请求体非法或为空；清单 / 播放 URL 的 `tpl` 非 cuid 形状 |
| `invalid_credentials` | 401 | 登录失败（用户不存在 / 口令错误 / `status≠ACTIVE` 统一提示，不泄露账号状态） |
| `unauthorized` | 401 | JWT 缺失 / 过期 / 签名不符（`/v1/media*` 业务面） |
| `bad_token` | 403 | 播放 token 缺失 / 非法 / 过期 / `typ` 或 `mid` 绑定不符 / 会话已吊销或过期 |
| `not_found` | 404 | 媒资未入库；主 / 子清单对象缺失；密钥行不存在；字幕轨道或对象缺失；未知路由（JSON 信封，非 HTML） |
| `not_playable` | 409 | 媒资非 READY；`template_id` 指定的产物不存在；多套产物且无默认模板（消息列出可选值） |
| `session_limit` | 409 | 并发播放会话上限命中（仅 `max_concurrent_sessions>0` 时检查） |
| `internal` | 500 / 503 | 查询 / 存储 / 签发失败；`MASTER_KEYS` 缺该 `mk_ver`；`signing_keys` 无可用私钥时 `login` 返回 503 |

`rate_limited` / `not_implemented` / `forbidden` 为契约保留码，v1 分发端不返回（限频未实现，见 §6.6）。

**响应头与 CORS**：

- `Content-Type`：JSON `application/json; charset=utf-8`；改写后清单 `application/vnd.apple.mpegurl; charset=utf-8`；CEK `application/octet-stream`；字幕 `text/vtt; charset=utf-8`；
- **清单 / 密钥 / 字幕一律 `Cache-Control: no-store`**（P0 缓存纪律，CI 门禁）；`GET /healthz` → `{"status":"ok","app":"delivery"}`；
- CORS 为全路由中间件（含预检）：`Access-Control-Allow-Origin` 按 `DELIVERY_CORS_ORIGINS`（`*` = 全部，播放鉴权不带 Cookie 故无凭证泄露面）；Allow-Methods `GET, POST, OPTIONS`（OPTIONS → 204）；Allow-Headers `Content-Type, Authorization, X-Playback-Token, Range`；Expose-Headers `Content-Length, Content-Range, Accept-Ranges`（浏览器直连对象存储读分片所需）。

### 6.2 解密链路（一次播放的顺序）

1. `login` 取 JWT（业务 API 用；**不用于清单 / 密钥 / 分片**）；
2. `play` 建会话并返回签名主清单 URL；
3. 拉主清单 → 子清单（`tpl` + typ=m token）；
4. 子清单里 `#EXT-X-KEY` 的 URI 已被改写为 `/v1/media/{id}/key?t=<typ=k>`（`METHOD` / 显式 `IV` 原样保留）；分片行一律改写为 **S3 预签名直出 URL**（字节不经过函数，P0；`STORAGE_CDN_BASE_URL` 可替换 origin）——`typ=s` 不再签发；
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

> 启动最小集（ADR-0015）：进程最早只要求 `DELIVERY_DATABASE_URL` + `MASTER_KEYS`；下表其余项均可由 `system_settings` 提供并约 60s 整体热切换（失败保留上一版完整配置），env 同名键兜底。

| 变量 | 默认 | 说明 |
|---|---|---|
| `DELIVERY_DATABASE_URL` | 无（必填） | 分发端受限账号（ADR-0011：只读约定表 + `playback_sessions` 读写）。支持 `mysql://user:pw@host:port/db` 或 go-sql-driver DSN；**本地调试需指向可达库**（仓库 `.env` 里的 127.0.0.1 是占位） |
| `MASTER_KEYS` | 无（必填） | 主密钥 `版本:64位hex`（逗号分隔多版本，ADR-0006）：解封 CEK（按 `hls_keys.mk_ver`）与 JWT 私钥（逐版本尝试）。**轮换后必须保留旧版本**，否则旧产物密钥接口 500 |
| `DELIVERY_LISTEN` | `:9000` | 监听地址；SCF Web 函数 / EdgeOne 平台固定 `:9000` |
| `APP_ENV` | `dev` | 运行环境标识（仅日志，不改变行为） |
| `DELIVERY_PUBLIC_BASE_URL` | 空 → `http://127.0.0.1:{端口}` | 播放 URL 基址（清单 / 密钥 / 字幕）；生产填分发域名。**运行时可被 `system_settings.playback_base_url` 覆盖**（分发端 60s 缓存读取，spec §2.1.2），无需重启 |
| `URL_SIGN_KEY_HEX` | 空 | 播放 token 的 HMAC 密钥（64 位 hex = 32 字节；生成 `openssl rand -hex 32`）。ADR-0015 后可由 `system_settings.url_sign_key_hex`（MK 封装）提供；两处都缺则启动失败（安全失败，拒绝签发 token）。**更换会使已下发的签名链接立即失效** |
| `URL_SIGN_KEY_KID` | `urlsign-v1` | 播放 token 的 `kid`（多 kid 宽限轮换为演进项） |
| `DELIVERY_JWT_ISSUER` | `openvod-delivery` | JWT `iss` |
| `DELIVERY_JWT_TTL_SEC` | `86400` | JWT 有效期（ADR-0007：默认 24h，无 refresh） |
| `PLAYBACK_SESSION_TTL_SEC` | `14400` | 播放会话有效期 |
| `PLAYBACK_MANIFEST_TTL_SEC` | `14400` | 清单 token / 预签名有效期上限（token exp ≤ 会话 exp；上限 7 天，同时约束 S3 SigV4 预签名） |
| `PLAYBACK_SUBTITLE_TTL_SEC` | `86400` | 字幕 token 有效期上限（`@openvod/shared DEFAULTS.subtitleTtlSec`）；实际 `exp` 取与会话 `exp` 的较小值（§7.5） |
| `STORAGE_ROOT_PREFIX` / `S3_*` | 对齐管理端 | 与 `packages/storage` 同源命名（§1.5）；仅 S3 兼容存储（ADR-0005 2026-09-22 修订，`STORAGE_DRIVER` / `STORAGE_LOCAL_ROOT` 已删除） |
| `STORAGE_CDN_BASE_URL` | 空 | 对象存储加速域名（ADR-0005 统一加速域名方案，管理端 / 分发端共用命名）：配置后 **GET 预签名 URL 的 origin 替换**为该域名（管理端 original / 封面预览 302、presign 模式分片直出），路径与签名 query 原样保留；上传预签名不受影响。前提：CDN 回源 COS 且 **Host 透传 / 改写为桶端点**（SigV4 签名覆盖 Host），缓存按 query 不缓存或短 TTL 配置。**2026-10-05 实测踩坑**：CDN 缓存键若忽略查询串，① 同路径重转码后播放端**永远读到旧分片**（产物按模板树原位替换，路径不变；预签名 query 每次不同但缓存键相同），表现为「改了水印 / 模板重转后画面没变化」；② **无签名请求可命中缓存绕过 URL 鉴权**（裸打分片 URL 返回 200）。缓存键必须含完整 query（不过滤参数），或启用 CDN URL 鉴权，二者必居其一 |
| `DELIVERY_CORS_ORIGINS` | `*` | 允许跨域读取清单 / 密钥 / 分片（管理端「产物解密播放」的 hls.js 需要）；播放鉴权全走 URL token、不带 Cookie，`*` 不引入凭证泄露面，可收敛为管理端源站（逗号分隔） |

分发端消费的 `system_settings` 键（DB 优先、env 兜底；键名与 `packages/shared SETTING_KEYS` 手工对齐）：`s3_endpoint` / `s3_region` / `s3_bucket` / `s3_access_key_id` / `s3_secret_access_key`（MK 封装）/ `s3_force_path_style` / `storage_root_prefix` / `storage_cdn_base_url` / `url_sign_key_hex`（MK 封装）/ `url_sign_key_kid` / `jwt_ttl_sec` / `playback_session_ttl_sec` / `playback_manifest_ttl_sec` / `playback_subtitle_ttl_sec` / `cors_origins` / `playback_base_url`。

### 6.6 M3 已落地范围外（演进项）

- ~~CDN + EdgeOne TypeA 分片鉴权~~ —— **已关闭（2026-09-20 用户修订，ADR-0005）**：不再引入 EdgeOne CDN，s3 形态 **S3 预签名直出定为最终形态**（M3 已实现并验证；曾短暂引入分发端代理模式后回退删除）；可配 `STORAGE_CDN_BASE_URL` 加速域名替换预签名 origin；
- 登录 / play **限频**（ADR-0010）；严格模式（key 一次性 nonce、IP / UA 绑定、并发上限的踢下线，ADR-0006 §7 默认关）；
- 会话吊销的进程内 60s 缓存（当前每请求查库，语义更严格、量级可接受）；
- SQLite 自托管驱动（当前 Go 侧仅 MySQL；ADR-0004 的单机同卷形态待补）；
- ~~`custom_data` **公开白名单**~~ —— **已实现（2026-09-24，ADR-0016 / §8.4）**：`custom` 按白名单输出 `category` / `description` / `tags`（管理端写入投影，分发端做类型校验后下发），其余键一律丢弃；`poster_url` 已随仅-S3 决策全量预签名直出；
- **cursor 分页**（ADR-0010 契约）：`GET /v1/media` 当前只支持 `limit`（缺省 50 / 上限 200）、`next_cursor` 恒为 `null`，媒资规模需要时再实现；
- 字幕链路（M4）**已实现（2026-09-20）**：规范见 §7.5；字幕进 CDN 缓存（ADR-0009 原始设想）仍为演进项，前置条件是引入内容版本号 / 共享 token 形态。

**部署前置（非未完成项）**：管理端「产物 → 播放」由浏览器直连对象存储拉分片（仅 S3 形态），要求**对象桶 CORS 放行管理端源站**（与封面截帧同一前提，§2.3）——未配置时表现为「有总时长但一直转圈」（分片请求被浏览器拦截），播放弹窗会在等待超时后给出该提示。播放器为 Video.js v10（与媒资预览同一皮肤），HLS 由 `@videojs/hlsjs-video`（hls.js / MSE）承载，Safari 由 Video.js 自行回退原生 HLS。

## 7. 字幕（WebVTT，M4）

> 决策源 ADR-0009（本节按实现细化，冲突时以本节为准并回写 ADR）。本节定义管理端（控制面）与分发端（数据面）的字幕规则。格式 v1 仅 **WebVTT**，不入 HLS 打包。

### 7.1 轨道模型

- **一媒资多轨**：一条轨道 = `media_subtitles` 一行 + 一个对象 `proceed/{id}/subtitles/{trackId}.vtt`；同一媒资可并存多条轨道（按语言区分），互不覆盖；
- **`trackId`（轨道唯一 ID）**：服务端生成的唯一 ID，**同时是 `media_subtitles.id`、存储文件名与 API 路径参数**；形状与模板 ID 同形（cuid 形状 `^c[a-z0-9]{20,}$`），便于统一做路径白名单校验（防路径注入）；
  - 生成**先于落库**（存储键必须先于 DB 行确定），故由应用层生成并显式写入主键，不依赖 Prisma `@default(cuid())`；
  - 一经写入**不再变更**（编辑文本 / 改展示名 / 改语言均不变键），保证播放端已持有的引用长期有效；
- **`lang`（语言）**：BCP-47（RFC 5646）语言标签，规范形态用连字符（`zh-CN` / `en-US` / `ja-JP`）；**输入兼容**下划线写法（`zh_CN` / `en_US`）与任意大小写，服务端归一化（language 小写、script 首字母大写、region 大写）后存储与返回；非法标签 400。动机：`<track srclang>`、HLS `LANGUAGE`、iOS / Android 选轨 API 均以 BCP-47 为准，下划线仅为历史 UI 写法；
  - **同一媒资内 `lang` 唯一**（DB 唯一约束 `(media_id, lang)`）：播放端按语言选轨无歧义；重复 409 `bad_request`。不同语言区域的同语言轨（`zh-CN` / `zh-TW`）视为不同语言，可并存；
- **`label`（展示名）**：必填，1–64 字符（播放器字幕菜单展示；不参与选轨逻辑）；
- **`is_default`（默认轨）**：每媒资**至多一条**默认轨；首条上传的轨道自动置默认；显式设默认时在事务内把该媒资其它轨道置 `false`（MySQL / SQLite 均无「部分唯一索引」，故为应用层事务保证）；
- **`status`**：`PROCESSING` / `READY` / `FAILED` 取值保留（Prisma `SubtitleStatus`），但 **v1 上传为同步校验** —— 通过即写 `READY`；失败直接 400 且**不落库、不落存储**（不留 `FAILED` 残留行）。`PROCESSING` / `FAILED` 留给未来异步链路（语音转写 / 机器翻译）；
- 其余列：`storage_key`（不含 root 的相对对象键）、`bytes`（对象字节数）、`created_by`（管理端账号 id）。

### 7.2 存储与生命周期

- 落键 `proceed/{mediaId}/subtitles/{trackId}.vtt`：`subtitles` 是 `proceed/{id}/` 下的**保留段**（`PROCEED_RESERVED_SEGMENTS`）—— 不参与模板产物分组（§1.4 的 `products[]`）、不被「按模板删除产物」（§2.1）清理、也不随重转码变化；
- **写入顺序**：先 `put` 对象、再落 DB 行（与封面上传同序）；对象写入失败 → 不落库，返回 500；
- **存储对象恒为 WebVTT**（`{trackId}.vtt`）：`.srt` 仅作输入，在上传 / 覆盖时转换（§7.3），不落 SRT 对象；
- **文本编辑 = 就地覆盖同一对象**（trackId 与键不变）；分发端字幕响应 `no-store`（§7.5），编辑后下一次请求即取到新文本；
- **删除轨道 = 先删对象、再删 DB 行**（与媒资删除同序，幂等可重试）：对象已不存在视为成功；删默认轨后**不自动改派**新默认轨（允许暂时无默认，避免意料外的轨道切换）；
- **媒资删除**：`proceed/{id}/` 整子树删除自然覆盖字幕对象，`media_subtitles` 随 `media` 级联删除（§2.1）；
- 单文件上限 `SUBTITLE_MAX_BYTES` = **5 MiB**（远低于 P0 的 6MB 响应体上限，MB 级长片字幕足够）。

### 7.3 输入格式与校验（SRT 自动转 VTT；只校验不重排）

**输入格式**：`POST /subtitles` 与 `PUT /{trackId}/content` 都接受 `.vtt` 与 `.srt`，按**内容**识别（不看扩展名 / 不信任文件名）：

- 首个非空行以 `WEBVTT` 开头 → 视为 WebVTT，直接进入校验；
- 否则含至少一条 SRT 时间轴行 `00:00:01,000 --> 00:00:03,000` → 视为 SubRip，**服务端自动转为 WebVTT** 后进入校验：时间轴逗号改点、小时补齐两位、前置 `WEBVTT` 头、序号行原样保留（WebVTT 允许 cue 标识行）、丢弃 SRT 专有定位参数（时间轴行尾的 `X1:… / Y1:…` 等，WebVTT 不支持）；
- 两者都不是 → 400（消息同时提示支持 `.vtt` 与 `.srt`）。

**存储恒为 WebVTT**：对象键固定 `proceed/{id}/subtitles/{trackId}.vtt`，不并存 SRT 对象、不保存 SRT 原文（v1 仅 WebVTT，intent.md 非目标）。

上传与覆盖文本时逐条校验，任一项不满足 → 400 `bad_request`（消息指出原因）：

1. 请求体为非空字节流且 ≤ `SUBTITLE_MAX_BYTES`（转换后体积再校验一次 —— 补 `WEBVTT` 头会略增）；
2. **合法 UTF-8**（非法字节序列拒绝）；允许并剥离 UTF-8 BOM；
3. 首个非空行以 `WEBVTT` 开头（允许 `WEBVTT - 说明` 形态）；
4. 至少一条 cue：存在 `时间轴 --> 时间轴` 行，时间戳为 `HH:MM:SS.mmm` 或 `MM:SS.mmm`；每条 cue 结束时间**严格大于**开始时间；
5. 归一化仅限：换行统一为 `\n`（`\r\n` / `\r` → `\n`）、去 BOM、SRT→VTT 的时间轴改写；其余内容**原样存储**（不重排、不重编号、不修时间轴，ADR-0009）；
6. 转换与校验都是纯函数，落 `apps/admin/src/lib/vtt.ts`（`toVttText` 统一入口 / `convertSrtToVtt` / `validateVttText`，唯一使用方是管理端，带单测）；分发端只读取与下发，不做格式处理。

### 7.4 管理端 API（`/api/admin/media/{id}/subtitles`）

沿用 §2 通用约定（better-auth 会话守卫、统一错误信封、响应 `no-store`、敏感操作落 `audit_logs`）；请求体为**原始 VTT 字节流**（`Content-Type: application/octet-stream`，与 §2 上传协议一致，不经 multipart 缓冲）。

| 端点 | 方法 | 说明 |
|---|---|---|
| `/api/admin/media/{id}/subtitles` | GET | 轨道列表：`id`(trackId) / `lang` / `label` / `is_default` / `status` / `bytes` / `storage_key` / `created_at` / `updated_at`，另附 `storage_ok`（对象存在性；存储不可用为 null）；顺序 `is_default DESC, created_at ASC` |
| `/api/admin/media/{id}/subtitles` | POST | 新建轨道：查询参数 `lang`（必填，归一化后校验）/ `label`（必填 1–64）/ `is_default`（可选）→ 校验 VTT（§7.3）→ 生成 trackId → 写对象 → 落 `media_subtitles`（`status=READY`、`created_by`=当前管理端账号）→ 审计 `subtitle.create`；返回 201 轨道 DTO。`lang` 重复 409；媒资未入库 404 |
| `/api/admin/media/{id}/subtitles/{trackId}` | PATCH | 更新元信息（JSON：`label` / `lang` / `is_default`）：`lang` 走同一归一化与唯一校验（409）；`is_default=true` 事务内把其它轨道置 `false`；审计 `subtitle.update` |
| `/api/admin/media/{id}/subtitles/{trackId}/content` | PUT | 覆盖字幕文本（原始 VTT 字节流）：同一校验（§7.3）→ 就地覆盖对象 → 更新 `bytes` / `updated_at`；审计 `subtitle.update`（detail 含 bytes） |
| `/api/admin/media/{id}/subtitles/{trackId}` | DELETE | 删除轨道（先对象后行，幂等）；审计 `subtitle.delete` |

- 轨道不存在 / 不属于该媒资 → 404 `not_found`；`trackId` 形状不符 → 404（路由层先校验，防路径注入）；
- 不提供「按语言批量替换」「自动翻译 / 转写」等入口（非目标，intent.md）。

### 7.5 分发端 API（字幕链路）

| 端点 | 鉴权 | 说明 |
|---|---|---|
| `GET /v1/media/{id}` | JWT | 详情 `subtitles[]`（`MediaSubtitleDTO`：id / lang / label / is_default）——**不含 URL**（URL 需会话 token）；已实现（查 `status=READY`） |
| `POST /v1/media/{id}/play` | JWT | 响应新增 `subtitles[]` = `{id, lang, label, is_default, url}`：`url` = `{DELIVERY_PUBLIC_BASE_URL}/v1/media/{id}/subtitles/{trackId}.vtt?t=<typ=v token>`，`exp = min(now + PLAYBACK_SUBTITLE_TTL_SEC, 会话 exp)`。理由：字幕鉴权必须走 URL query token（Safari 原生 HLS 无法带请求头，ADR-0006），而 token 必须绑定 `sid` 才可吊销 —— 只有会话上下文（play）能签发，故随 play 一并下发，播放端零额外往返 |
| `GET /v1/media/{id}/subtitles/{trackId}.vtt` | token(v) | 取 VTT 文本（下述规则） |

`.vtt` 端点执行规则（顺序即安全边界）：

1. `trackId` 形状白名单（cuid 形状）→ 不符 404（路由层先拦）；
2. `authorize(typ=v, mid={id})`：token 校验（query `t` 优先，其次 `X-Playback-Token`）+ `mid` 绑定 + 会话未过期未吊销 —— 未携带 / 非法 / 已吊销 → 403 `bad_token`（纳入 `assert-unsigned-403` 门禁）；
3. DB 查轨道 `id=trackId AND media_id={id} AND status=READY`；不存在 → 404 `not_found`；
4. 读对象以行内 `storage_key` 为准（**不按 URL 拼键**，保持键可迁移）；对象缺失 → 404；
5. 输出：**由分发端代理输出**（`blob.Get` 读整对象写出，v1 仅 S3 形态）—— 若改走预签名 302，对象响应头（`no-store`）与跨域策略都不受分发端控制，而 `no-store` 是「就地覆盖、下一次请求即生效」的前提；P0 的「分片字节不经过函数」只约束分片，字幕不适用（≤5 MiB，低于 6MB 响应体上限）；
6. 响应头 `Content-Type: text/vtt; charset=utf-8`、`Cache-Control: no-store`（与清单 / 密钥同纪律：token 逐会话签发、文本可被就地覆盖，缓存会读到陈旧字幕）；ADR-0009 的「CDN 可缓存」列为**演进项**，前置条件是引入内容版本号 / 共享 token 形态；
7. **不入 HLS 清单**：v1 由播放端外挂轨道（`<track>` / hls.js `addTextTrack`）引用 `play` 返回的 URL；`EXT-X-MEDIA TYPE=SUBTITLES` 需分段 playlist，列为演进项（ADR-0009）。

分发端受限 DB 账号对 `media_subtitles` 只需**只读**（ADR-0011），本链路无 DB 写入。

### 7.6 管理端页面

字幕管理有**两个入口，共用同一轨道面板**（组件 `SubtitleTracksPanel`，避免两处实现漂移）：

- **侧边栏「字幕管理」（`/subtitles`）**：顶部为可搜索的媒资选择器（选项形如 `ID · 展示名（N 条字幕）`），默认选中「已有字幕的第一个媒资」（没有则选最新媒资），下方渲染该媒资的轨道面板；
- **媒资页「更多 → 字幕管理」**（`/media`）：抽屉（Drawer）内嵌同一面板。

轨道面板（遵循 §3.0 表格滚动约定）：

- 工具栏：**上传字幕**（弹窗：`.vtt` / `.srt` 文件（SRT 自动转 VTT，成功提示会标注「SRT 已自动转换为 VTT」）+ 语言（AutoComplete 预置 `zh-CN` / `zh-TW` / `en-US` / `ja-JP` / `ko-KR`，允许自由输入、服务端归一化）+ 展示名 + 「设为默认」开关）+ 刷新 + 轨道条数；
- 表格列 = 语言标签（`lang`，默认轨打标）、展示名（`label`）、状态、体积、轨道 ID（等宽 + 复制）、对象存在性（`storage_ok` 为 `false` 时提示「缺失，请删除后重新上传」）、更新时间；
- 行操作：
  - **预览**：弹窗播放 **original 原视频**（同源 `GET /media/{id}/original`，支持 Range 拖动）并挂上该轨道的 WebVTT —— 与媒资预览**同一 Video.js 皮肤**，字幕走原生 `<track kind="subtitles" srclang=lang label=label default>`，可在播放器字幕菜单切换 / 关闭；字幕源为 `GET /media/{id}/subtitles/{trackId}/content`（`no-store`，编辑后重新打开即最新）；`storage_ok=false` 时按钮禁用（提示对象缺失）；
  - **编辑**（展示名 / 语言 / 设为默认，不重传文件）、**替换内容**（重选 `.vtt` / `.srt` 就地覆盖，提示播放端下一次请求即取到新文本）、**删除**（确认弹窗：对象与 DB 行一并删除、不可恢复、不自动改派默认轨）；
- 上传 / 编辑失败时把 §7.3 的校验原因直接展示在弹窗内。

### 7.7 相关常量与环境变量

| 名称 | 默认 | 说明 |
|---|---|---|
| `PLAYBACK_SUBTITLE_TTL_SEC` | `86400`（`@openvod/shared DEFAULTS.subtitleTtlSec`） | 字幕 token 有效期上限；实际 `exp` 取与会话 `exp` 的较小值 |
| `SUBTITLE_MAX_BYTES` | `5 * 1024 * 1024` | 单字幕文件上限（常量，非环境变量） |
| `SUBTITLE_LABEL_MAX` | `64` | 展示名长度上限（常量） |

### 7.8 契约与生成物

- `MediaSubtitleDTO`（详情用）保持不变；新增 `PlaybackSubtitleDTO` = `MediaSubtitleDTO + url`，`PlaybackResponse` 增加 `subtitles: PlaybackSubtitleDTO[]` —— 二者均在 `gen-json.ts` 清单内，需重跑 `task contracts` 并提交生成的 Go struct（CI `check:contracts-go` 门禁）；
- 管理端字幕 DTO 仅管理端消费（分发端不消费），与模板 / 密钥 / 用户组同规则：**不进 `gen-json.ts` 清单、不生成 Go struct**；
- quicktype 命名：`PlaybackResponse.subtitles` 的条目在契约里带内联 `title: "PlaybackSubtitle"`（zod `.meta({ title })`），生成 Go 类型 `PlaybackSubtitle` —— 否则会与 `MediaDetail` 内联出的 `Subtitle` 在同一个 Go 包内重名；
- 双端已就位、无需新增：`TOKEN_TYPES.subtitle = "v"`（`@openvod/shared`）与 Go `token.TypeSubtitle`、`STORAGE_KEYS.proceedSubtitle`、`PROCEED_RESERVED_SEGMENTS`、`DEFAULTS.subtitleTtlSec`；
- Go 侧新增：`store.SubtitleByID`（读 `storage_key`，限定 `status=READY`）与 `internal/server` 的 `.vtt` handler；
- Prisma：`media_subtitles` 表已存在（ADR-0009 / ADR-0004）；本功能仅需补 `@@unique([media_id, lang])` 约束（迁移）。

## 8. 媒资分类、描述与标签（自定义元数据，2026-09-24）

> 决策源 ADR-0016（分类模型 / 投影 / 公开白名单）；本节按实现细化，冲突时以本节为准并回写 ADR。
> 一句话：**分类是独立实体（无限层级树），描述与标签是媒资属性，三者一起构成 v1 的「自定义元数据」**——
> 写入 `media.custom_data` 的**稀疏投影** + 导出 `metadata/{id}/custom.json`，并由分发端按**公开白名单**下发。

### 8.1 数据模型与分类树规则

- `media_categories`（分类，管理端独立模块）：`id`（cuid）、`name`（≤64）、`description`（≤191）、`parent_id`（自关联，可空 = 顶级）、`sort_order`（同级排序，越小越靠前）、`is_system`（系统内置标记）、时间戳；
  - **无限层级**：邻接表表达层级，不限制深度；树在应用层组装（管理端 `apps/admin/src/lib/category-tree.ts`），接口返回**扁平列表**（层级由 `parent_id` 表达）；
  - **同级重名不允许**：DB 唯一索引 `(parent_id, name)` + 应用层同级查询（顶级 `parent_id IS NULL` 在 MySQL / SQLite 中互不相等，必须应用层兜底）→ 409；
  - **环路禁止**：移动时拒绝「目标上级 = 自身或自身子孙」→ 409；所有树递归都带 visited 集合（脏数据不无限递归）；
  - **删除**：有子分类 → 409（先删 / 先移走）；删除**不删媒资**，该分类下的媒资**迁入默认分类「其他」**（见下条；DB 层 `ON DELETE SetNull` 仅作兜底）；
- **系统默认分类「其他」**（`is_system = true`，固定 id `cother00000000000000000` = `@openvod/shared MEDIA_DEFAULT_CATEGORY_ID`）：
  - **「未设置分类」不是合法终态**：未设置分类的媒资默认归入「其他」，三条路径保证 —— ① **上传**即落 `category_id` + 投影；② `PATCH /api/admin/media/{id}` 的 `category_id: null`（移出分类）等同归入「其他」；③ 读取路径对历史 `NULL` 值仍**回退**为「其他」（`pickCategoryRef`）；
  - **不可删除**（409：系统默认分类）；改名 / 描述 / 排序可改（id 不变）；默认 `sort_order = 10000`，即顶级末尾；
  - **幂等确保存在**：MySQL 由迁移插入（`20260924130000_default_category`）+ 回填历史行（`20260924140000_backfill_default_category`）；SQLite 开发库（`db push`，无种子）与任何缺口由读取路径 `ensureDefaultCategory()` 补齐（主键固定 → 并发创建安全）；
  - 分类名「其他」在顶级下唯一（同级重名校验照常生效）；
- `media` 新增三列：`category_id`（可空外键 → `media_categories.id`，`SetNull`）、`description`（`String?`，≤191，**视频 / 媒资自身的描述**——与分类描述 `media_categories.description` 是两回事，界面统一叫「视频描述」）、`tags`（`Json?`，字符串数组）；
  - **标签**：≤20 个、每个 ≤32 字符；服务端 `normalizeMediaTags` 去首尾空白、丢弃空串、按首次出现去重（大小写敏感）；空数组按 `NULL` 落库；
  - **长度上限口径**：`description` 的 191 字符与 `name` / `title` 一致，对齐 Prisma `String` 在 MySQL 的 `VARCHAR(191)`（双方言 schema 必须逐字一致，不能引入 `@db.Text` 这类单方言属性）；
- 分类**只决定归属与展示路径，不参与播放鉴权**（分发端不查该表）。

### 8.2 管理端 API（分类 CRUD + 媒资自定义元数据）

- 分类：`GET/POST /api/admin/categories`、`PATCH/DELETE /api/admin/categories/{id}`（端点与错误码明细见 §2.1）；
  - 写操作审计 `category.create` / `category.update` / `category.delete`（`category.update` 的 detail 含 `refreshed_media`）；
  - `GET` 的 `media_count` 为**直属**媒资数（未设置分类的历史媒资计入默认分类「其他」）；`descendant_media_count` 为**含子孙**媒资数（**保留字段**：当前管理端不展示，仅 API 返回）；条目含 `is_system`（前端据此禁用删除）；
- 媒资字段：`PATCH /api/admin/media/{id}`（`contracts UpdateMediaRequest`）支持 `title`（重命名）/ `description` / `tags` / `category_id` 任意组合，字段缺省 = 不修改；
  - `description: null` = 清空；`tags: null` 或 `[]` = 清空；`category_id: null` = **归入默认分类「其他」**（显式给 id 时该分类必须存在，否则 404）；至少一个字段，否则 400；
  - 校验失败 400（zod 首条 issue 带字段路径）；媒资未入库 404；审计 `media.rename`（title）与 `media.metadata_update`（其余三项，detail 含 `custom_object_written`）；
- 读取：`GET /api/admin/media`（列表）与 `GET /api/admin/media/{id}`（详情）都附分类引用（含路径）/ 描述 / 标签；详情另有 `custom`（**恒三项**，`null` / `null` / `[]` 表示空，便于表单回填）与 `customData`（稀疏投影原文）。

### 8.3 自定义元数据投影（`custom_data` 与 `custom.json`）

- **形态（稀疏）**：只出现非空项（无分类 / 空描述 / 空标签数组都不出现该键）：

  ```json
  {
    "category":    { "id": "c…", "name": "科幻", "path": "电影 / 科幻" },
    "description": "简介文本",
    "tags":        ["4K", "科幻"]
  }
  ```

- **写入**：**上传**新媒资即写入默认分类「其他」的投影（新媒资不留空），此后每次保存分类 / 描述 / 标签时由管理端重算（`mergeCustomData`）→ 落 `media.custom_data` → 导出 `metadata/{id}/custom.json`（同内容、2 空格缩进、幂等覆盖）；
  - 投影**保留白名单之外的扩展键**（历史 / 手工写入的键不被一次保存抹掉）；
  - 导出物是**投影副本**：写失败只告警并在响应中标记（`customDataWritten=false`），**不回滚 DB**（DB 为准，下次保存补齐）；
  - `custom_data.category` 的 `name` / `path` 是**快照**（分发端零 join 输出的前提）；
- **刷新时机**（分类结构变化 → `path` 快照必须跟着变）：
  - 分类**改名 / 移动**：刷新该分类**子树**下全部媒资（`updateCategory` 内同步执行，响应 `refreshed_media` 回报条数）；**默认分类「其他」改名 / 移动时，未设置分类的历史媒资（`category_id IS NULL`）一并刷新**；
  - 分类**删除**：删除前收集受影响媒资并**迁入默认分类「其他」**（`updateMany`），删除后再刷新（分类键换成「其他」）；
  - 删除媒资：`metadata/{id}/` 整目录随 `deleteMedia` 一并删除（§2.1），无需单独处理；
  - v1 **同步逐条**执行（分类与受影响媒资规模小）；超大规模演进为异步任务；
- 仅分类**不改名 / 不移动**时投影不重算（描述与标签写入自身即重算）；
- **历史数据回填**：迁移 `20260924140000_backfill_default_category` 把升级前 `category_id IS NULL` 的媒资补齐分类与投影（只落 DB；`metadata/{id}/custom.json` 由下一次保存补齐）。

### 8.4 分发端下发（公开白名单）

- `GET /v1/media`（列表）与 `GET /v1/media/{id}`（详情）的 `custom` = 白名单对象 `{ category?, description?, tags? }`（**缺省键不出现**；无内容时 `{}`）：
  - `category`：仅保留 `id` / `name` / `path` 三个非空字符串（`id` 或 `path` 缺失则整项丢弃）；
  - `description`：仅保留非空字符串（trim 后为空则丢弃）；
  - `tags`：字符串数组（逐项 trim、去重、上限 20；结果为空则丢弃）；
  - **白名单之外的键一律丢弃**（如内部备注 / 运维字段），避免把内部字段暴露给播放端；
- 解析容错：列为 `NULL` / 空串 / 非法 JSON / 非对象 → `{}`，**播放链路不因元数据脏数据中断**；
- 实现：`apps/delivery/internal/server/custom.go`（键名与 `@openvod/shared MEDIA_CUSTOM_KEYS` 手工对齐），单测 `custom_test.go` 覆盖白名单裁剪与类型容错；
- 分发端**不查 `media_categories`**（受限 DB 账号无需该表授权，ADR-0011）：分类信息完全来自投影快照。

### 8.5 管理端页面

- **`/categories`（分类管理，独立模块）**：树形表格（antd `children` 层级，默认展开有子节点的行，遵循 §3.0 滚动约定）+ 新建顶级分类 / 刷新；列：分类名（默认分类「其他」带「默认」标记）/ 描述 / 直属媒资 / 排序 / 更新时间；行操作：新建子分类（表单预设上级）/ 编辑 / 删除（Popconfirm 提示「直属媒资将归入默认分类「其他」、媒资不被删除」）；
  - **默认分类「其他」**行带「默认」标记（Tooltip 说明），删除按钮**禁用**（服务端同样 409）；
  - 编辑弹窗：上级分类（TreeSelect，含「顶级分类」项；**自身与子孙禁选**，服务端仍会二次校验环路）/ 分类名（≤64）/ 描述（≤191）/ 同级排序（0–10000）；
- **`/media`（媒资页）**：
  - 列表新增「分类 / 标签」列（分类完整路径或「未分类」Tag；标签最多 2 个 + 「+N」悬停全量）与**独立的「描述」列**（**视频描述**，即 `media.description` —— 与「分类管理」页里分类的描述 `media_categories.description` 是两回事，空显示「—」，超长省略号 + 悬停全文）；
  - 「更多 → 分类、描述与标签」与详情弹窗「编辑自定义元数据」打开**同一弹窗**：分类 TreeSelect（无限层级、可搜索，**留空 = 归入默认分类「其他」**，占位提示同义）/ **视频描述**（TextArea，191 上限，带计数）/ 标签（`Select mode="tags"`，回车或逗号分隔，客户端校验单标签 ≤32 字符，服务端去重）；
  - 保存成功提示；`metadata/{id}/custom.json` 导出失败时给出**黄色告警**（元数据已保存，不影响播放端下发）；
  - 详情弹窗「自定义元数据」区块：分类路径 Tag / 描述 / 标签，附投影 JSON 折叠块（标注分发端按白名单下发）。

### 8.6 契约与生成物

- 分类与媒资更新 DTO（`MediaCategoryDTO` / `MediaCategoryListResponse` / `CreateMediaCategoryRequest` / `UpdateMediaCategoryRequest` / `MediaTagsRequest` / `UpdateMediaRequest` / `MediaCustomMetadataDTO`）**仅管理端消费**：**不进 `gen-json.ts` 清单、不生成 Go struct**（同模板 / 密钥 / 用户组 / 字幕管理端 DTO）；
- 分发端消费的 `custom` 仍是 `z.record(z.string(), z.unknown())`（**结构由本节 §8.4 定义，不在 Go 侧生成类型**）——白名单键名在 `@openvod/shared MEDIA_CUSTOM_KEYS` 与 Go `internal/server/custom.go` 手工对齐；
- `packages/shared` 新增常量与纯函数：`MEDIA_CATEGORY_ID_PATTERN` / `MEDIA_CATEGORY_NAME_MAX` / `MEDIA_CATEGORY_DESCRIPTION_MAX` / `MEDIA_CATEGORY_SORT_MAX` / `MEDIA_CATEGORY_PATH_SEPARATOR` / `MEDIA_DESCRIPTION_MAX` / `MEDIA_TAGS_MAX` / `MEDIA_TAG_LENGTH_MAX` / `MEDIA_CUSTOM_KEYS` / `mediaCategoryPath` / `normalizeMediaTags` / `buildMediaCustomData`（含单测）；
- Prisma：新增 `media_categories` 模型（含 `is_system`）与 `media.category_id` / `description` / `tags` 列；迁移三条 —— `20260924120000_media_categories`（建表 / 加列）、`20260924130000_default_category`（`is_system` + 插入默认分类「其他」）、`20260924140000_backfill_default_category`（历史行回填分类与投影）；双方言 schema 的 enum/model 段必须逐字一致（`task db:parity` 门禁）；SQLite 开发库 `db push` 后由运行时 `ensureDefaultCategory()` 补建默认分类；
- Go 侧：`internal/server/custom.go`（白名单解析）+ `mediaListItem` / `handleMediaDetail` 使用它；`store.Media.CustomData` 列早已读取，SQL 无改动。

## 9. 上传页与上传任务（客户端队列，2026-10-01）

> 决策（用户 2026-10-01 定）：上传从媒资列表的内联按钮升级为**独立页面「上传视频」**（`/media/upload`）；
> 上传任务由**管理端浏览器侧的客户端队列**承载（**无新端点、无 DB 迁移、无服务端任务表**）。
> 服务端上传协议与端点**不变**（§2 原始字节流 `application/octet-stream`；§2.1 `/api/admin/media/upload`），`docs/vod/api.md` 无需改动；
> 本功能不引入新 ADR（不改服务端协议与数据模型），演进项（分片直传）挂 ADR-0005「上传路径演进」。

### 9.1 页面与入口

- **`/media/upload`「视频上传」**（新增页面）：页面内容 = 拖拽上传区（§9.3）+ 上传任务列表（§9.3）；页头标题由 `ConsoleShell` 的菜单项推导；
- 侧边栏「媒资管理」为**二级菜单**（2026-10-01 用户修订：与「系统设置」同构，**替代**本节最初「保持扁平菜单」的决定）：子项「视频管理」（`/media`）与「视频上传」（`/media/upload`），父项仅展开不导航；两个子页均加入 `ConsoleShell` 的 `ROUTE_PAGES`（不在白名单会显示 scaffold 占位）；
- 媒资管理页（`/media`）工具栏「上传视频」按钮改为 **`router.push("/media/upload")`**：移除内联的 antd `Upload` 文件选择、`uploadTo` / `uploadingName` / `uploadPct` 状态与 `watchMetadataInBackground`（职责移入 §9.4 队列）；
- **「视频上传」菜单项 Badge**（2026-10-01 用户定，**替代**早前「App 右上角全局入口」方案）：存在进行中上传任务（`UPLOADING / QUEUED`，§9.2）时，侧边栏「视频上传」菜单项右侧渲染 antd `Badge` 显示数量；无进行中任务不渲染（不显示 0）；右上角不放全局入口；
- 任务内存中保留至「移除 / 清空已完成」：同一浏览器会话内来回切页，任务列表与进度仍可见。

### 9.2 任务模型与状态机

- **任务 = 一个文件**；字段：`id`（客户端生成）、`file`（`File`，仅内存）、`filename`、`size`、`status`、`loadedBytes` / `pct`（0–100）、`mediaId`（成功后的媒资数字 ID）、`error`（失败原因）、`createdAt` / `startedAt` / `finishedAt`、`metadata`（`pending | ready | timeout`）；
- 状态机（单向流转；取消 / 重试是仅有的回边；**「开始上传」把全部待上传任务批量转入排队**，2026-10-01 用户定）：

| 状态 | 含义 | 允许操作 |
|---|---|---|
| `PENDING` | 已加入列表，尚未开始上传（等待「开始上传」） | 移除 |
| `QUEUED` | 已点击「开始上传」，等待并发槽位 | 取消 |
| `UPLOADING` | XHR 上传中（`pct` 由 `xhr.upload.onprogress` 驱动） | 取消 |
| `METADATA` | 上传成功（`mediaId` 已生成），元数据异步生成中 | —（上传已结束，不可取消） |
| `DONE` | 任务成功（`metadata=ready`） | 移除、复制媒资 ID、去媒资列表 |
| `FAILED` | 上传失败（网络 / HTTP 错误 / 存储失败 / 登录过期） | 重试、移除 |
| `CANCELED` | 用户取消（中止 XHR） | 重试、移除 |

- `DONE` 且 `metadata=timeout`（轮询序列耗尽）：展示黄色告警「元数据仍在生成或已失败，可在媒资页「更多 → 生成元数据」手动重跑」（语义同 §2.1 现有实现）；
- **取消** = `xhr.abort()` → `CANCELED`；服务端语义（§2.1）：请求中断 → `uploadOriginal` 按「存储写入失败」回滚占位行；但存在「存储已写完、响应未返回」的窗口——该窗口内取消**媒资已入库**。故取消后提示「若该文件已上传完成，媒资仍会出现在列表」（列表页每次挂载重新拉取，无需额外机制）；
- **重试**：仅 `FAILED / CANCELED` 可重试 → 重新入队（新 XHR、`pct` 归零、清 `error`），复用同一 `File` 对象（不重新读盘）；
- **移除**：仅终态可移除；「清空已完成」批量移除 `DONE / FAILED / CANCELED`；
- **不做跨刷新 / 跨标签页持久化**（v1）：状态仅存内存单例；刷新 / 关闭页面即中断（进行中任务丢失，服务端按中断语义回滚；见 open-questions #20）。

### 9.3 页面交互

- **拖拽区**（antd `Upload.Dragger`，`multiple`、`accept="video/*"`、`showUploadList={false}`）：
  - `beforeUpload` 一律 `return false`（关闭 antd 默认 POST），把本次选择 / 拖入的**全部文件**逐个加入任务列表（`PENDING`，**不立即上传**——2026-10-01 用户定：先入列，点「开始上传」再统一上传）；
  - 一次拖入 N 个文件 = N 条任务；同一文件重复拖入允许（各自新建媒资，服务端不做去重）；
  - 入队前预检：`size = 0` 的任务直接判 `FAILED`（不发起请求）；非视频文件仅靠浏览器 `accept` 过滤提示，服务端仍按扩展名 `sanitizeExt` 校验（400 → 任务 `FAILED`）；
- **任务列表**（antd `Table`，一行一任务，遵循 §3.0 滚动约定）：
  - 列：文件名（省略号 + 悬停全名）/ 大小（复用 `formatSize` 语义）/ 状态 Tag / **进度**（antd `Progress`：`UPLOADING` 显示百分比；`METADATA` 显示 `active` 动画 + 「元数据生成中」；终态不显示）/ 媒资 ID（成功后展示，可一键复制）/ 耗时 / 失败原因；
  - 操作：移除（待上传 / 终态）/ 取消（排队中、上传中）/ 重试（失败、已取消）/ 「去媒资列表」（成功）；批量：「**开始上传**」（主按钮：把全部待上传任务转入排队执行，2026-10-01 用户定）、「重试全部失败」、「清空已完成」；
  - 实时更新由队列 `notify` 驱动（客户端订阅，无需轮询 / SSE，与 `/jobs` 的 SSE 链路无关）；
- 终态提示：转 `DONE(ready)` → `message.success`（文件名 + 媒资 ID）；转 `DONE(timeout)` → `message.warning`；转 `FAILED` → `message.error`（原因）；
- **离开确认**：存在进行中任务时注册 `beforeunload`（浏览器原生确认框），任务全部终止 / 清空后解除。

### 9.4 客户端队列实现（复用与落位）

- 队列为**模块级单例**：`apps/admin/src/lib/upload-manager.ts`（纯 TS、不依赖 React，依赖注入以便单测）——`enqueue(files)`（仅入列，不发起请求）/ `startAll()`（待上传批量转入排队并按并发执行）/ `cancel(id)` / `retry(id)` / `remove(id)` / `clearFinished()` / `subscribe(listener)` / `getSnapshot()` / `activeCount()`；
- React 绑定用 `useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)`：快照必须**不可变替换**（变更时整体换新引用）并提供稳定的 `getServerSnapshot`（SSR 首帧空列表），避免无限重渲染；页面卸载只移除订阅者，**不中止 XHR**——这是「切换页面不影响上传」的实现前提；
- **并发上限 2**（前端常量 `UPLOAD_CONCURRENCY = 2`，非服务端配置）：超出排队，任务结束后自动接续下一个；动机：单请求流式上传独占出口带宽，且服务端每请求在 `after()` 内跑一次 ffprobe，2 路是吞吐与资源的折中；
- **两段式执行（2026-10-01 用户定）**：入队只加列表（`PENDING`）不占并发槽位；「开始上传」把全部 `PENDING` 批量转入 `QUEUED`，**并发槽位只消费 `QUEUED`**——重试与运行批次接续都不会拉起未开始（`PENDING`）的任务；
- 上传实现沿用现有 XHR 范式（`POST /api/admin/media/upload?filename=…`、`xhr.send(file)`、`upload.onprogress`），从 `MediaList.tsx` 抽出并扩展 `abort()`、错误分类与队列调度；
- **元数据阶段**复用 `lib/metadata-poll.ts` 的 `pollMetadataReady`（依赖注入不变）：任务成功后置 `METADATA` → 轮询详情 → `probe` 就绪置 `DONE(metadata=ready)`；序列耗尽置 `DONE(metadata=timeout)`；
- 认证与错误：401 → 跳 `/login` 并终止队列（进行中任务置 `FAILED`，原因「登录已过期」），不再继续接续排队任务。

### 9.5 边界与非目标

- **v1 非目标**：断点续传 / 分片直传（`presignPut` multipart，ADR-0005 上传路径演进）、上传任务跨刷新 / 跨标签页持久化、服务端上传任务表与查询 API（open-questions #20）、暂停 / 恢复、上传限速；
- 上传端点、协议、服务端并发语义不变：**无新端点、无 DB 迁移、无 Go 侧改动**；
- 单文件大小沿用平台现状（上传路由 `maxDuration = 600`；S3 侧分片由 `@aws-sdk/lib-storage` 内部处理），本页不新增限制；
- 上传任务与转码任务（`/jobs`，DB + SSE）是两条独立链路，不复用其模型。

### 9.6 验收与测试

- 单测（`apps/admin/test/upload-manager.test.ts`，`bun test`；上传器与轮询以依赖注入替身注入，不真实发请求）：入队不自动开始（暂存 `PENDING`）、「开始上传」批量执行与并发上限（第 3 个排队，前者结束自动开始）、运行中新入队不被拉起、进度换算、取消（中止 + `CANCELED`）、失败重试（新请求且不拉动待上传）、移除（待上传 / 终态）/ 清空已完成、`METADATA` → `DONE(ready)` / 超时 → `DONE(timeout)`、401 → 队列终止（待上传不受影响）；
- 手工验收：① 拖入 3 个视频 → 全部「待上传」；点击「开始上传」→ 2 个并发上传 + 1 个排队，进度实时刷新；② 上传中切到 `/media`、`/jobs`、`/`，回到上传页进度连续未中断，侧边栏「视频上传」菜单项 Badge 显示进行中数量；③ 上传中刷新页面 → 任务清空（出现原生离开确认，若已确认）；④ 成功任务显示媒资 ID，`/media` 列表可见该媒资并最终出现 probe 元数据；⑤ 取消 / 失败 / 重试 / 清空路径与 §9.2 状态表一致。

## 10. 水印（图片 / 文字，转码烧录，2026-10-02）

> 决策源 ADR-0018（模板落库 + `watermark/` 分区 + 仅 ffmpeg 滤镜烧录）；本节为 specification 细化，冲突时以本节为准并回写 ADR。
> 一句话：水印是**管理端维护的模板**（图片 / 文字两类），转码模板可选关联其一，Worker 在转码重编码阶段用 **ffmpeg 原生滤镜**把水印**烧录进各档画面像素**；分发端 / 播放端 / 播放契约零感知，产物布局与分发链路零改动。

### 10.1 模板模型与参数校验

**`watermark_templates` 表**（Prisma 双方言 + `db:parity` 门禁；对齐 ADR-0014 模式：管理端写 CRUD，Worker 只读**任务快照**消费，不回查模板表）：

| 列 | 说明 |
|---|---|
| `id` | 模板 ID（cuid），同时是图片存储文件名 |
| `name` | 展示名，唯一，≤64 字符 |
| `description` | ≤191 字符，可空 |
| `type` | enum `image` / `text`（`WatermarkType`），**创建后不可改** |
| `image_ext` / `image_key` / `image_bytes` / `image_width` / `image_height` | 仅图片型（文字型恒 null）：扩展名（png / jpg / webp）、不含 root 的存储键、字节数、像素宽高（**上传时管理端 ffprobe 探测回填**） |
| `params` | JSON（`WatermarkParams`，zod 唯一真相源，见下） |
| `created_at` / `updated_at` | 时间戳 |

**`WatermarkParams`（公共参数，两类一致）**：

| 参数 | 规则 |
|---|---|
| `anchor` | 九宫格锚点枚举：`top_left` / `top_center` / `top_right` / `middle_left` / `center` / `middle_right` / `bottom_left` / `bottom_center` / `bottom_right`（必填） |
| `offset_x` / `offset_y` | 整数 −4096…4096，默认 0；带符号位移（x 正 = 右移、y 正 = 下移），施加在锚点对齐之后（换算表见 §10.4） |
| `opacity` | 0–100 整数，默认 100 |
| `blend` | `normal`（默认）/ `overlay`——混合方式「正常 / 叠加」 |

**尺寸 `size`**（两类同形、含义按类型；`mode: "pixels" | "percent"` 二选一）：

- **图片型**：
  - `pixels`：`width` / `height` **至少一项**（1–7680 px）——两项给定时**精确缩放**到该尺寸（允许变形）；仅一项时按**原图宽高比等比**换算另一维（用 `image_width` / `image_height`）；
  - `percent`：`width` / `height` **至少一项**（1–100）——对应维 = 画面宽 / 高 × 百分比；仅一项时等比（同上）；两项时分别按对应边缩放（允许变形）。
- **文字型**：
  - `pixels`：`size` = 字号像素（4–512）；
  - `percent`：`size` = 字号 = 输出高度 × size%（取整）。

**文字型专属**：

| 参数 | 规则 |
|---|---|
| `text` | 1–64 字符（`WATERMARK_TEXT_MAX`），trim 后非空，不含控制字符（单行）；**另不含 ASCII 单引号 `'`**——ffmpeg 的滤镜 / 选项分词器（`av_get_token`）遇 `'` 即进入引号区且不处理反斜杠，字面 `'` 无法送达 `drawtext`（2026-10-05 实测标定，见 §10.4 末） |
| `font` | 枚举，取值 = `@openvod/shared WATERMARK_FONTS`（v1：`sans` / `sans_bold` / `serif`，对应 Worker 镜像内置 Noto CJK 字体；键 → fontfile 映射两端同源） |
| `color` | `#RRGGBB` hex（大小写均可） |
| `shadow` | `null`（默认，无阴影）或对象 `{ color: "#RRGGBB", offset_x: −100…100, offset_y: −100…100 }` |

校验失败 400 `bad_request`（消息指出字段与原因）；`name` 重复 409。**无透明通道格式（jpg）的图片水印在「正常」模式下是不透明矩形**——透明底水印应使用 png / webp（表单提示）。

### 10.2 存储与生命周期

- 图片落 `watermark/{templateId}.{ext}`（`STORAGE_KEYS.watermark`，§1.2 / §1.3）：按模板 ID 组织，**不属于任何媒资的资产集合**——媒资删除 / 重转码不触碰；Content-Type 按扩展名映射（`image/png` 等）；
- **两步创建（图片型）**：`POST /watermarks`（JSON）建行 → `PUT /watermarks/{id}/image`（octet-stream 字节）写对象并回填 `image_*` 列；图片未上传（`image_key` 为空）的模板**不可被转码模板关联**（§10.4 校验拒绝）；文字型一步完成；
- **换图 = 覆盖式 PUT** 同一键（与封面 poster 同语义）：扩展名变化时删除旧对象；`image_*` 列重探重写，尺寸换算口径随新图生效；
- **删除**：先删 `watermark/` 下该模板全部对象，再删 DB 行（幂等可重试，对象已不存在视为成功）；**被任一转码模板引用 → 409**（先解除引用；已入队 / 已完成任务不受影响——快照自包含）；审计 `watermark.delete`；
- 图片上限 `WATERMARK_IMAGE_MAX_BYTES` = **2 MiB**；格式白名单 png / jpg / webp，**按内容识别**（与扩展名无关，同字幕 §7.3 的内容识别思路）；
- 文字型无任何存储对象；水印图片与媒资上传、封面共用 S3 凭据面，不新增权限。

### 10.3 管理端 API（`/api/admin/watermarks`）

沿用 §2 通用约定（better-auth 会话守卫、统一错误信封、响应 `no-store`、敏感操作落 `audit_logs`）；端点文档见 `api.md §1.4b`。

| 端点 | 方法 | 说明 |
|---|---|---|
| `/api/admin/watermarks` | GET | 模板列表（创建时间倒序）：全部列 + `image_status`（文字型恒 `ready`；图片型 `ready` / `missing`）+ `referenced_by`（引用它的转码模板数，一次 groupBy） |
| `/api/admin/watermarks` | POST | 新建（JSON：`type` / `name` / `description` / `params`）：文字型一步完成；图片型返回 `image_status="missing"`，随后必须 PUT 图片；审计 `watermark.create` |
| `/api/admin/watermarks/{id}` | GET | 详情（全列 + `referenced_by`） |
| `/api/admin/watermarks/{id}` | PATCH | 更新 `name` / `description` / `params`（`type` 不可改）；审计 `watermark.update` |
| `/api/admin/watermarks/{id}/image` | PUT | 上传 / 替换图片（octet-stream ≤2 MiB，内容识别格式）→ 写 `watermark/{id}.{ext}` → ffprobe 探测宽高回填 `image_*` 列；审计 `watermark.image_upload` |
| `/api/admin/watermarks/{id}/image` | GET | 图片预览（列表缩略图 / 表单预览）：s3 预签名 302（同 cover 语义，`STORAGE_CDN_BASE_URL` 替换 origin）；文字型 404 |
| `/api/admin/watermarks/{id}` | DELETE | 删除（§10.2；被引用 409）；审计 `watermark.delete` |

### 10.4 转码集成（关联、快照、滤镜链）

**关联与两层校验**

- `transcode_templates.watermark_id`：可空外键 → `watermark_templates.id`（应用层删除引用检查在前，DB `SetNull` 兜底）；一个转码模板至多关联一个水印，一个水印可被多个转码模板引用；
- 非法组合在**模板保存与任务发起两层**拒绝（同「加密必须 HLS」模式）：
  - `keep_original=true && watermark_id` → 400（烧录必须重编码，`-c copy` 无法叠加画面）；
  - `watermark_id` 指向图片型但 `image_key` 缺失 → 400（提示先上传水印图）；
- **快照**：submit 时把水印模板内容随任务快照固化进 `transcode_jobs.template_snapshot.watermark`：`{ id, name, type, params, image_key?, image_ext?, image_width?, image_height? }`——模板 / 图片后续变更**不影响已入队任务**（ADR-0014 快照机制沿用）；Worker 只读快照；submit 审计 detail 含 `watermark_id`。

**滤镜链（v1 全部 ffmpeg 原生滤镜）**——统一「**全帧水印层 → 合成**」两段管线，两类水印 × 两种混合方式共用同一编译路径：

1. **构建水印层 L**（与该档输出同尺寸的全帧透明画布 `color=black@0.0:s=WxH,format=rgba`）：
   - **图片**：图片作为 ffmpeg **第二输入**（单帧，`-i <预签名 URL>`，argv builder 固定**不加** `-loop 1`）→ `scale` 到目标尺寸（**编译期数值**，见下）→ `format=rgba,colorchannelmixer=aa=<opacity>` → `overlay` 到画布的编译期坐标（带 `shortest=1` 把画布收敛为单帧）→ 最终合成时由 overlay 的 `eof_action=repeat` 铺满主输入时长；
   - **文字**：画布上直接 `drawtext`——`fontfile`（`font` 枚举映射）、`text`（统一纯函数按 drawtext 转义规则转义，绝不经 shell）、`fontsize`（编译期数值）、`fontcolor=<color>@<opacity>`、`shadowcolor` / `shadowx` / `shadowy`（可选）、`x` / `y` **运行期表达式**（`main_w` / `main_h` / `text_w` / `text_h`）；文字型**不需要第二输入**；
2. **合成到视频**：
   - **正常**（`blend=normal`）：`[主输入][L]overlay=0:0:format=auto,format=yuv420p`——标准 alpha 合成，水印层外区域自然不受影响；
   - **叠加**（`blend=overlay`）：`[主输入]format=gbrp,split=2` → `[va][L→gbrp]blend=all_mode=overlay`（全帧逐像素 Overlay 混合）→ `[L 的 rgba 副本]alphaextract,format=gray` 得掩码 → `[vb][混合结果][掩码]maskedmerge,format=yuv420p`——掩码把混合**限制在水印像素内**（无水印区域保持原画面；边缘抗锯齿像素按 alpha 部分混合）；透明度已烘进 L 的 alpha，由掩码加权生效。

**格式与坐标的实测约束**（2026-10-05 在 ffmpeg 6.1 上标定，单测与端到端测试锁死）：

- **画布内 alpha=0 区域必须恒为纯黑**（`color=black@0.0` 已保证）——这是 maskedmerge 正确性的前提：掩码为 0 处取原画面，画布 RGB 不参与结果；
- **合成输出像素格式显式钉 `yuv420p`**：`overlay=format=auto` 会协商出 `yuva420p` / `yuv444p`（带 alpha 或 4:4:4），既浪费码率又可能不被部分播放器接受。副作用：10-bit 源在**带水印**时会被降到 8-bit（不带水印的模板不受影响），v1 接受；
- **叠加模式的 blend / maskedmerge 走 `gbrp`**（无 alpha 的平面 RGB）而非 `rgba`：rgba 下 alpha 平面会参与逐平面混合，实测得不到预期结果（ffmpeg 6.1）；
- **水印存在时改走 `-filter_complex` + `-map [wmwm_out]` + `-map 0:a?`**（`-vf` 无法表达「水印层 + 合成」两段）；无水印的模板 argv 形态与既有实现逐字一致，不受牵连。**音频映射必须显式带上**：一旦出现任一 `-map`，ffmpeg 对该输出文件的自动流选择整体失效（不再自动挑最佳音轨），只映射视频滤镜输出会产出**无声视频**（2026-10-05 实测踩坑，两层端到端测试以「去映射必红」守卫）；`?` 表示源无音轨时静默忽略，与 `compileKeepOriginal` 的 `-map 0:a?` 同形态；
- **全档跳过（intent 规则 2）时由 `compileSourceMatched` 兜底出一档，水印照常烧录**——不会出现「配了水印却没烧录」；
- **drawtext `text` 转义规则**：ffmpeg 在 `-filter_complex` 与选项值上各做一遍分词，字面量还要穿过 `drawtext` 自身的 `%` 展开器。实测标定：整串单引号包裹，`\`→`\\`、`%`→`\\%`（裸 `%` 触发 `Stray %` 且**整段文字不渲染**）、`:`→`\:`、`,;[]`→`\c`；字面 `'` 不可达（故 §10.1 拒绝该字符）。规则集中在 `packages/transcode/src/watermark.ts::escapeDrawtextText`，纯函数 + 单测。

**定位换算表**（九宫格锚点 + 偏移；`W`/`H` = 该档输出宽高；`w`/`h` = 水印渲染尺寸——图片为缩放后尺寸（编译期已知），文字为 `text_w`/`text_h`（运行期））：

| 锚点 | x | y |
|---|---|---|
| `top_left` | off_x | off_y |
| `top_center` | (W − w)/2 + off_x | off_y |
| `top_right` | W − w + off_x | off_y |
| `middle_left` | off_x | (H − h)/2 + off_y |
| `center` | (W − w)/2 + off_x | (H − h)/2 + off_y |
| `middle_right` | W − w + off_x | (H − h)/2 + off_y |
| `bottom_left` | off_x | H − h + off_y |
| `bottom_center` | (W − w)/2 + off_x | H − h + off_y |
| `bottom_right` | W − w + off_x | H − h + off_y |

- 偏移为**带符号**位移（x 正 = 右、y 正 = 下）；右 / 下锚点常配**负偏移**做内边距；偏移可把水印移出画面（ffmpeg 按坐标裁剪，不做额外限制）；坐标取整遵循滤镜原生 `trunc` 行为；
- **尺寸换算全部在 argv 编译期完成**（纯函数）：Worker 已知该档输出宽高（§5.4 判定结果：缩放档为模板目标尺寸、保持档为源尺寸）与快照参数（含 `image_width` / `image_height`），直接产出数值 argv——不依赖 scale 滤镜做画面百分比（scale 无 `main_w` 变量）；文字坐标例外，用 drawtext 运行期表达式；
- **执行位置**：滤镜链挂**每档变体缩放之后、编码与切片之前**（烧录进像素后才编码）；逐档独立构建水印层（比例尺寸与定位按**各档实际输出分辨率**换算）；与加密 / HLS 切片同一 ffmpeg 管线，不新增独立处理步骤；
- **性能注记**：「叠加」为全帧逐像素处理（rgba + blend + maskedmerge），转码耗时显著高于「正常」模式——v1 接受，模板作者按需选择。

**产物与播放**：烧录后水印即画面像素的一部分——产物布局（§1.3 / §5.5）、清单改写、分发链路、播放端**零改动**；`hls_keys` 与水印无关（同一模板产物共用 CEK 不变）；**更新水印 = 重新转码**，模板 / 图片变更不影响已产出内容。

### 10.5 管理端页面

- **侧边栏「水印管理」（`/watermarks`，独立模块，加入 `ROUTE_PAGES`）**：模板列表表格（遵循 §3.0 滚动约定）——预览缩略（图片型经 GET `/{id}/image`；文字型按所选字体 / 颜色渲染小样）、名称、类型（图片 / 文字 Tag）、参数摘要（锚点 / 偏移 / 透明度 / 混合 / 尺寸或字号）、被引用数、图片状态（图片型 `missing` 黄标「待上传」）、更新时间；
- **新建 / 编辑弹窗**：类型选择（图片 / 文字，创建后不可改）+ 公共参数（九宫格位置选择器、x / y 偏移、透明度 Slider 0–100、混合方式 Radio：正常 / 叠加）+ 类型专属（图片：图片上传（拖拽 / 选择，png / jpg / webp）+ 尺寸模式表单；文字：文本内容、字体下拉（`WATERMARK_FONTS`）、颜色选择器、阴影开关与颜色 / 偏移）+ 名称 / 描述；
- **实时预览**：弹窗内以**浏览器侧 CSS / DOM** 按当前参数在 16:9 样板画面上叠加示意（图片 `<img>` 或按所选字体样式渲染的文字），**服务端不渲染预览图**——预览与 ffmpeg 成像的一致性由 §10.4 的参数语义唯一保证；
- **删除**：确认弹窗注明「已产出的视频不受影响；被转码模板引用时需先解除引用（409）」。

### 10.6 相关常量

| 名称 | 默认 | 说明 |
|---|---|---|
| `WATERMARK_IMAGE_MAX_BYTES` | `2 * 1024 * 1024` | 水印图片上限（常量，非环境变量） |
| `WATERMARK_NAME_MAX` / `WATERMARK_DESC_MAX` | `64` / `191` | 模板名 / 描述上限（对齐分类管理口径） |
| `WATERMARK_TEXT_MAX` | `64` | 文字内容上限 |
| `WATERMARK_OFFSET_MAX` | `4096` | x / y 偏移绝对值上限（阴影偏移 ±100） |
| `WATERMARK_FONTS` | `sans` / `sans_bold` / `serif` | 字体枚举（`@openvod/shared`），Worker 镜像内置 Noto CJK 对应 fontfile |
| `WATERMARK_FONT_DIR` | `/usr/share/fonts/opentype/noto` | 镜像内置字体目录（Debian `fonts-noto-cjk` 安装路径），drawtext `fontfile` 根 |

无新增环境变量；字体文件随 Worker 镜像分发（`apps/worker/Dockerfile` 装 `fonts-noto-cjk` 并在**构建期** `test -f` 自检三份字体；`apps/worker/src/index.ts` 启动时再自检一次并**告警不退出**——`drawtext` 的 `fontfile` 缺失时 ffmpeg 不报错而是静默回退 fontconfig 默认字体，中文会渲染成豆腐块且任务仍报成功）。换字体需同步改 `WATERMARK_FONT_FILES`（`@openvod/transcode`）与镜像层。

### 10.7 契约、迁移与生成物

- **zod（`packages/contracts`）**：`WatermarkParamsSchema`（按 `type` 判别联合：公共参数 + 图片尺寸 / 文字专属）、`WatermarkTemplateDTO` / `WatermarkCreateRequest` / `WatermarkUpdateRequest`——仅管理端与 Worker（TS）消费，**不进 `gen-json.ts` 清单、不生成 Go struct**（与模板 / 密钥 / 用户组同规则，§7.8）；`TranscodeTemplateDTO` / `Create` / `Update` 增加可选 `watermark_id` 透传字段；`TranscodeTemplateSnapshot` 增加 `watermark` 可选段（`WatermarkSnapshot`）并带 `superRefine` 兜底（`keep_original` 携带水印 / 图片水印缺 `image_key` → 快照非法，Worker 直接判任务不可执行）；`TranscodeSubmitJob` 增加 `watermark_id`；
- **`@openvod/shared`**：`STORAGE_KEYS.watermark(id, ext)`、`WATERMARK_ANCHORS`（九宫格枚举）、`WATERMARK_BLEND_MODES`、`WATERMARK_FONTS` / `WATERMARK_FONT_DIR` 与 §10.6 常量（Go 侧不消费，无需对齐）；
- **Prisma**：新增 `watermark_templates` 模型与 `WatermarkType` / `WatermarkBlend` 枚举；`transcode_templates.watermark_id` 可空外键（`SetNull`）+ 反向关系 `WatermarkTemplate.templates`——双方言 schema **逐字一致**（`task db:parity`），expand 迁移 `20261002100000_watermark_templates`（建表）与 `20261005100000_transcode_template_watermark`（加列 + 索引 + 外键，只加不改）；改 schema 后必须 `task db:generate`（dev-workflow §8）；
- **Worker**：`template_snapshot.watermark` 只读消费——图片型按 `image_key` 预签名取图（`presignGet`，字节不落盘，ffmpeg 原生支持 http 输入），文字型无第二输入；argv builder 扩展水印滤镜链编译（`packages/transcode/src/watermark.ts`）——**纯函数、单测覆盖**：两类 × 两混合方式 × 九宫格边界（负偏移 / 贴边 / 越界）× 等比与变形缩放 × opacity 0/100 × drawtext 转义；
- **审计**：新增动作 `watermark.create` / `watermark.update` / `watermark.image_upload` / `watermark.delete`；`media.transcode_submit` detail 含 `watermark_ids`（多选模板故为列表，§10.4）。

### 10.8 验收与测试

- **纯函数单测**（`packages/transcode/test/watermark.test.ts`，`bun test`）：图片尺寸换算（pixels 两项精确 / 单项等比、percent 逐档按各自输出分辨率、结果下限 1px、缺原图尺寸报错）、文字字号（pixels / percent 逐档）、九宫格定位换算表全 9 项 + 负偏移 / 越界 / 正偏移带号、drawtext 转义（`\` `%` `:` `,;[]` 中文空格）、fontfile 映射、滤镜链编译（正常 / 叠加两条链的完整形状、缺 imageUrl 报错、脏参数报错、比例尺寸逐档差异、opacity 0/35/100）；
- **argv 接入单测**（`packages/transcode/test/template.test.ts`）：有水印走 `-filter_complex` + `-map`、无水印 argv 形态不变、逐档编译、跳过的档位不产 argv、`compileSourceMatched` 兜底档带水印、文字水印不追加第二输入、`keep_original` 路径不含滤镜链；
- **真 ffmpeg 端到端**（`packages/transcode/test/watermark.ffmpeg.test.ts`，缺 ffmpeg 整组跳过）：源片**带音轨**（sine，防「无声视频」回归），用编译出的 argv 真跑一遍，与「同模板无水印」产物逐像素比对——图片正常模式的**变化像素包围盒 == 期望矩形**（`(640−100−20, 360−50−20)` 起、100×50）、比例尺寸的等比换算、移出画面 / `opacity=0` 画面**完全不变**、叠加模式区域外无污染、文字水印落在右下且不越界、**产物音轨与无水印基准一致**（ffprobe 断言，漏 `-map 0:a?` 必红）；
- **编排单测**（`apps/admin/test/transcode-submit.test.ts`）：水印快照固化（含图片元数据）、无水印时快照 `watermark` 为 `null`、`keep_original` 携带水印 → 400、图片水印未上传 → 400、水印已被删 → 404；
- **Worker 端到端**（`apps/worker/test/executor.test.ts`）：图片水印按 `image_key` 取图并烧录（产物字节与无水印不同）、文字水印无需第二输入、两类脏快照（`keep_original` 带水印 / 图片水印缺 `image_key`）直接判任务失败；
- **手工验收**：① 新建图片水印 → 上传图（宽高自动回填）→ 转码模板关联它 → 发起转码 → 产物右下角出现水印且画面其余部分无变化；② 改文字水印为「叠加」→ 重新转码 → 效果与「正常」明显不同；③ 保持原视频模板的水印下拉不出现；④ 解除关联后可删除水印模板，仍被引用时删除返回 409。
