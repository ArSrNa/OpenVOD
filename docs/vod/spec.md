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
{root}/original/{id}.{ext}                          # 原始上传（唯一确定媒资存在的对象）
{root}/proceed/{id}/master.m3u8                     # HLS 主清单模板（改写发生在分发端）
{root}/proceed/{id}/{variant}/index.m3u8            # 子清单
{root}/proceed/{id}/{variant}/seg-{n}.ts            # 分片（AES-128 加密）
{root}/proceed/{id}/subtitles/{trackId}.vtt         # 字幕
{root}/cover/{id}/poster.jpg                        # 海报 / 封面图
{root}/metadata/{id}/probe.json                     # ffprobe 系统元数据
{root}/metadata/{id}/custom.json                    # 业务扩展元数据
```

### 1.4 媒资列举规则（管理端「媒资列表」）

- **媒资集合以 `original/` 分区为准**：每个 `original/{id}.{ext}` 对象即一个媒资，`id` = 文件名去扩展名；
- `id` 必须为纯数字（`MEDIA_ID_PATTERN`）；非数字文件名或更深层级的对象不属于媒资，列举时忽略；
- 其余三个分区**只按 id 归组补充资产状态**（各分区下该 id 的对象数量），不反向定义媒资；
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

### 2.1 已实现（M1 媒资管理，2026-09-18）

| 端点 | 方法 | 说明 |
|---|---|---|
| `/api/admin/media` | GET | 媒资列表（§1.4 存储视角 + DB 展示名/状态合并） |
| `/api/admin/media/upload` | POST | 原视频上传（§1.3）：生成数字 ID（主键冲突即重取）→ 流式写 `original/{id}.{ext}` → `media` 行落库；存储失败回滚 DB 行 |
| `/api/admin/media/{id}` | GET | 详情：存储资产计数 + DB 元数据合并（`probe` 未实现前为 null） |
| `/api/admin/media/{id}` | PATCH | 重命名：仅修改 `media.title`，绝不改动 original 文件名与媒资 ID |
| `/api/admin/media/{id}` | DELETE | 删除：original 对象 + proceed/cover/metadata 三分区该 id 全部对象 + DB 行（级联 subtitles / transcode_jobs / hls_keys / playback_sessions）；幂等可重试。**级联范围说明**：open-questions #13 决议（软删 + 保留期 GC）之前的 v1 临时策略为**硬删除全级联** |
| `/api/admin/media/{id}/original` | GET | 原视频预览：local 模式 Range 字节区间流式代理（206）；s3 模式预签名 GET 302 重定向（字节不经管理端）；no-store |
| `/api/admin/media/{id}/cover` | POST | 上传封面：`cover/{id}/poster.{ext}`（jpg/png/webp/gif/avif）+ 回写 `media.poster_key`；手动上传 / 视频截帧双模式共用此端点（§2.3） |
| `/api/admin/media/{id}/metadata` | POST | 生成元数据：ffprobe 探测 original（local 直读文件路径 / s3 预签名 GET URL 供流）→ 原始输出落 `metadata/{id}/probe.json`，归一化摘要（宽高 / 帧率 / 色彩空间 / 编码 / 码率 / 音轨等，`@openvod/transcode summarizeProbe`）回写 `media.probe` + `media.duration_ms`；幂等覆盖式更新；落 `audit_logs`（`media.metadata_generate`）。要求运行环境安装 ffprobe |

### 2.2 未实现（501 占位，随里程碑落地）

| 端点 | 归属 | 说明 |
|---|---|---|
| `/api/admin/media/{id}/transcode` | M2（ADR-0008） | 转码发起：弹窗选 ladder / 模板 → `transcode_jobs` 入队；Worker `tick()` 同为空实现 |
| `/api/admin/media/{id}/subtitles` | M4（ADR-0009） | 字幕上传 / 管理：VTT → `proceed/{id}/subtitles/` 并绑定媒资 ID |
| 其余 `/api/admin/*` | 随 specification | `/users`、`/keys`、`/jobs` 等 |

- 未实现端点统一由 `/api/admin/[...path]` 返回 501 `not_implemented`（会话守卫仍然生效）；管理端 UI 对应项为 TODO 提示（点击提示所属里程碑）。

### 2.3 封面设置（poster，双模式）

媒资封面落位与回写对所有模式一致（open-questions #11：v1 每媒资仅一张 poster）：

- 落键 `cover/{id}/poster.{ext}`（spec.md §1.3），**覆盖式写入**（重复设置直接替换旧 poster）；
- 成功后回写 `media.poster_key`；落 `audit_logs`（动作 `media.cover_upload`）；
- 端点统一为 `POST /api/admin/media/{id}/cover`（原始图片字节流，octet-stream，§2 上传协议），不同模式仅是字节来源不同，服务端无差别。

**模式 A：手动上传（已实现）**

- 弹窗拖拽 / 选择本地图片（jpg / png / webp / gif / avif），原始字节直传端点。

**模式 B：视频截帧（规范新增，待实现）**

- 弹窗内播放 original 原视频（复用预览播放器），**拖拽进度条选择目标时间点**，取当前帧画面作为封面；
- 截帧在**浏览器侧**完成（`<video>` 当前帧 → canvas → JPEG），不依赖 ffmpeg / Worker，服务端零新增负载；产物以 `poster.jpg` 字节走同一端点，服务端逻辑与模式 A 完全一致；
- 导出约束：JPEG 质量 0.9；帧分辨率超过 1280px 最长边时等比缩小（控制封面体积）；
- 跨域前置：local 模式预览为同源 Range 代理，可直接截取；s3 模式预览为预签名 302 跳转，**要求对象桶 CORS 允许管理端源站**（否则 canvas 被污染、帧无法导出）；截帧失败（SecurityError）时提示改用手动上传，不阻塞端点。

## 3. 管理端页面

### 3.0 表格滚动约定（2026-09-18 用户规定，所有管理相关表格强制）

- 所有管理相关表格**必须**「表体限高、内部纵向滚动、表头固定」，页面本身不随条目数增长；内容超长必须滚动，不得撑开页面；
- 超宽表格同时横向滚动（antd `scroll.x` = 各列宽合计）；
- 统一复用 `apps/admin/src/components/tableScroll.ts` 的 `useTableBodyHeight`（视口高度推算 + resize 重算 + 极窄视口兜底），**不得各自实现**；
- 已实现页面：`/media`（媒资列表）、`/templates`（转码模板）；后续所有表格页面（用户 / 密钥 / 转码任务等）同样遵循。

### 3.1 已实现页面

- `/media`（媒资管理，M1 已实现）：媒资列表表格——媒资 ID、展示名、生命周期状态、原始文件（格式 / 大小 / 上传时间）、转码产物 / 封面 / 元数据的资产数量概览；
- `/templates`（转码模板，ADR-0014 已实现）：模板列表表格——模板名（默认标记）、描述、模式（转码 / 保持原视频）、加密（AES-128）、格式（M3U8）、参数摘要（编码器 / 码率或 CRF / 分辨率档位 / 帧率 / preset）、更新时间；操作：新建 / 编辑（弹窗表单，含分辨率档位多行编辑：固定宽×高或自适应上限约束）、删除（确认弹窗注明已发起任务不受影响）；API 见 §2（`/api/admin/templates`）。
- 操作（对应 §2.1）：上传视频（原始字节流直传，带进度）、预览（弹窗 `<video>` 播放 original，local 支持 Range 拖动）、详情（弹窗展示元数据：probe 摘要结构化展示——容器 / 分辨率 / 帧率 / 编码 / 像素格式 / 色彩空间 / 码率 / 音轨等 + 摘要 JSON 折叠块）、重命名（仅展示名）、删除（确认后硬删除全级联）、设置封面（弹窗双模式：手动上传 / 视频截帧，§2.3）、「更多 → 生成元数据」（ffprobe 探测，§2.1）；「更多」菜单中转码 / 字幕管理为 TODO（§2.2）。
