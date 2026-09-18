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
- 管理端 `GET /api/admin/media` 一次列举四个分区并按 id 内存聚合返回；v1 全量列举即可，分页 / 前缀裁剪留待媒资规模需要时再加。

### 1.5 相关环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `STORAGE_ROOT_PREFIX` | 空 | 全局 root 前缀（可多级，如 `prod/vod`），空 = 桶顶层 |
| `MEDIA_ID_LENGTH` | `8` | 媒资数字 ID 位数（4–16） |

## 2. 管理端 API（控制面，`/api/admin/*`）

- 复用 better-auth 会话守卫（Cookie），未登录 401；错误响应统一 `{ error: { code, message } }`，错误码沿用 `@openvod/shared ERROR_CODES`；
- 本期实现：
  - `GET /api/admin/media` — 媒资列表（存储视角，见 §1.4）。
- 其余端点保持 501 占位（`/api/admin/[...path]`），随功能逐个落地。

## 3. 管理端页面

- `/media`（媒资管理）：媒资列表表格——媒资 ID、原始文件（格式 / 大小 / 上传时间）、转码产物 / 封面 / 元数据的资产数量概览；为只读列表，上传与详情页随后续里程碑实现。
