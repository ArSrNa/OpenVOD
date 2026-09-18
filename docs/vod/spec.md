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

### 2.1 已实现（M1 媒资管理 + 密钥管理 + M2 转码，2026-09-18）

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
| `/api/admin/keys` | GET | 密钥列表（§4.3）：`hls_keys` + 媒资展示名/状态 + proceed 对象数（存储不可用时为 null）；**响应中不存在任何密钥材料字段**（契约层就不定义） |
| `/api/admin/keys/{mediaId}` | GET | 密钥详情：kid / method / iv / mk_ver / 生成时间 / 使用中会话数；明文 CEK 永不返回 |
| `/api/admin/keys/{mediaId}` | DELETE | 删除该媒资密钥行；存在未过期播放会话时 **409 拒绝**；落 `audit_logs`（`key.delete`） |
| `/api/admin/keys/mk` | GET | MK 版本状态：当前封装版本 + 各版本密钥用量（只暴露版本号与计数，无密钥材料） |
| `/api/admin/keys/rotate-mk` | POST | MK 轮换：把旧版本封装的 CEK 重封装到当前版本（`MASTER_KEYS` 最大版本），**无需重转码**；落 `audit_logs`（`key.rotate_mk`）。v1 同步执行，超大数据量演进为任务化分批 |
| `/api/admin/media/{id}/transcode` | POST | 发起转码（M2，§5）：校验媒资与原始文件存在、模板存在、`encrypt && format!=='HLS'` 拒绝、同媒资无未终结任务（409）→ 模板**快照**入队 `transcode_jobs`（`QUEUED`）；返回 202 `{job_id,status}`；落 `audit_logs`（`media.transcode_submit`）。**此阶段不生成 argv**（源参数未知，ADR-0014） |
| `/api/admin/jobs` | GET | 转码任务列表（创建时间倒序，最多 200 条）：状态、模板名（取快照，模板已删也可追溯）、`attempts`、`last_error`、各时间戳，并关联媒资展示名 |

### 2.2 未实现（501 占位，随里程碑落地）

| 端点 | 归属 | 说明 |
|---|---|---|
| `/api/admin/media/{id}/subtitles` | M4（ADR-0009） | 字幕上传 / 管理：VTT → `proceed/{id}/subtitles/` 并绑定媒资 ID |
| 其余 `/api/admin/*` | 随 specification | `/users` 等 |

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
- `/keys`（密钥管理，已实现）：密钥列表表格——媒资 ID、展示名、媒资状态、kid（截断 + Tooltip 全量）、算法、MK 版本（非当前版本标「待轮换」）、加密产物对象数、生成时间；顶部条展示当前封装版本与各版本密钥用量；操作：详情（弹窗：kid / IV / mk_ver / 生成时间 / 使用中会话数，并明确标注「明文密钥不展示」）、删除（确认弹窗警告需重转码才能恢复可播）、「轮换 MK」（确认后重封装旧版本，无需重转码）；API 见 §2.1 与 §4.3。**页面不提供任何明文密钥的展示 / 导出入口**。
- `/jobs`（转码任务，M2 已实现）：任务列表表格——任务 ID、媒资（ID + 展示名）、状态（排队 / 探测中 / 转码中 / 封装上传中 / 完成 / 失败）、模板名（取任务快照）、尝试次数、耗时、失败原因、创建时间；支持刷新与「自动刷新（5s）」；API 见 §2.1（`/api/admin/jobs`），执行规则见 §5。
- 操作（对应 §2.1）：上传视频（原始字节流直传，带进度）、预览（弹窗 `<video>` 播放 original，local 支持 Range 拖动）、详情（弹窗展示元数据：probe 摘要结构化展示——容器 / 分辨率 / 帧率 / 编码 / 像素格式 / 色彩空间 / 码率 / 音轨等 + 摘要 JSON 折叠块）、重命名（仅展示名）、删除（确认后硬删除全级联）、设置封面（弹窗双模式：手动上传 / 视频截帧，§2.3）、「更多 → 生成元数据」（ffprobe 探测，§2.1）、「更多 → 转码」（M2 已实现：弹窗选模板 → 展示该模板的模式 / 加密 / 输出格式 → 发起入队，落 `transcode_jobs`，进度跳「转码任务」页查看）；「更多 → 字幕管理」为 TODO（§2.2）。

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
- Worker 编排在 `apps/worker/src`：`media-keys.ts`（`loadMasterKeys` / `describeMasterKeys` / `generateMediaKey` / `persistMediaKey`）、`media-key-store.ts`（Prisma 事务整行替换的 `MediaKeyStore`）、`key-files.ts`（`keyUriPlaceholder` / `writeKeyFiles` / `cleanupJobDir`）；
- 管理端 MK 轮换复用同一组 crypto 函数（§4.3）；Worker 启动时做 MASTER_KEYS 自检（不可用只告警：未加密模板不依赖它）；
- **尚未实现**：任务认领 / 探测 / 逐档 ffmpeg / 产物上传（M2 其余部分）——接入点已在 `apps/worker/src/index.ts` 的 `tick()` 中按下列顺序逐条标注。

**执行顺序（顺序即安全边界）**：

1. `generateMediaKey(mks)`：生成 CEK(16B) + IV(16B) + kid，以 active MK（`MASTER_KEYS` 最大版本）封装——**此时不落库**；
2. `writeKeyFiles` 写 `{jobDir}/key_info` 与 `{jobDir}/ceks/{kid}.key`（CEK 为 **16 字节裸字节**）；key_info 三行 = 占位密钥 URI / CEK 文件路径 / **纯 hex IV**：
   - 第三行**不能带 `0x`**——ffmpeg 会自行加前缀，带上即产出 `EXT-X-KEY:...IV=0x0x…` 并报 `Error setting option encryption_iv`，加密失败且分片不产出（实测 ffmpeg 6.1）；`buildKeyInfoFile` 已归一化并有单测守卫（`packages/transcode`）；
3. ffmpeg 输出 AES-128 加密的 TS 分片 → 上传至 `proceed/{id}/{variant}/`（§1.3）；
4. **产物上传全部成功后**才 `persistMediaKey(store, mediaId, key)` → 写 `hls_keys`（每媒资一份，见下）；
5. 任务结束（成功 / 失败 / 取消）**必须** `cleanupJobDir(jobDir)`：key_info 与明文 CEK 随目录删除，不得残留。

**每媒资一份的落库语义（v1）**：`hls_keys.media_id` 唯一约束使「先插新行再删旧行」不可行，故存储层在**单个事务内先删旧行、再写新行**：

- 成功：旧 kid 立即失效，媒资恒只有一行密钥；
- 任一步失败：事务整体回滚，**旧密钥行原样保留**（不会出现「既无新也无旧」的空洞）——已有测试覆盖（kid 撞车场景）；
- 因此**绝不能提前落库**：若在转码前落库，一次失败的转码就会换掉该媒资密钥，使既有加密产物永久无法解密；
- 旧产物被整体覆盖，故不保留历史密钥行（不做同媒资多版本并存 / 双 kid 宽限）。

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
| CEK | 重转码（新 kid 替换，§4.2） | 该媒资短时维护窗口 |
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
- **同一媒资同时只允许一个未终结任务**：管理端发起时校验（409），避免并发转码互相覆盖产物。

### 5.2 执行顺序（顺序即正确性）

1. 产物先落本地 `{os.tmpdir()}/openvod-jobs/{jobId}/out/`（`{variant}/index.m3u8` + `{variant}/seg-%05d.ts`，主清单 `master.m3u8`），**全部成功后再整体上传**；
2. 上传完成后**才**落 `hls_keys`（§4.2）——提前落库会让一次失败的转码换掉旧密钥，使既有密文无法解密；
3. 上传成功后清理该媒资 `proceed/{id}/` 下**本次未产出**的对象（旧档位 / 旧分片），避免新旧混播；清理发生在上传之后，因此失败不会先毁掉旧产物；
4. 任意路径（成功 / 失败 / 取消）都要删除任务临时目录——其中含明文 CEK 与 `key_info`。

### 5.3 失败时的媒资状态

- 该媒资此前已是 `READY` → **保持 `READY`**：旧产物仍在且可播，不误报失败（此时只有 `job.last_error` 变化）；
- 否则 → `FAILED`；
- 失败原因写 `transcode_jobs.last_error`（管理端「转码任务」页展示，支持重派）。

### 5.4 产物布局与清单

- 上传后的键与 §1.3 布局一一对应：`proceed/{id}/master.m3u8`、`proceed/{id}/{variant}/index.m3u8`、`proceed/{id}/{variant}/seg-*.ts`；Content-Type：`.m3u8` = `application/vnd.apple.mpegurl`，`.ts` = `video/mp2t`；
- 变体目录名按**实际输出高度**命名（如 `1080p` / `150p`，同名追加序号）；`keep_original`（只加密流程）单档同规则；
- 主清单 `BANDWIDTH`：模板声明了目标码率则用之；CRF 模式与只加密流程按高度粗估（仅影响播放器起播选档提示，不影响编码）；
- 加密档位的子清单里 `EXT-X-KEY` 的 URI 是转码期**占位**，分发端改写清单时整体替换为带签名 token 的密钥 URL（ADR-0006 §3）。

### 5.5 Worker 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `WORKER_POLL_INTERVAL_MS` | `2000` | 轮询间隔（毫秒） |
| `WORKER_LEASE_MS` | `60000` | 任务 lease 时长（执行期按 1/3 续期） |
| `WORKER_MAX_ATTEMPTS` | `3` | 单任务最大尝试次数 |
