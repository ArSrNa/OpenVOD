# ADR-0005：对象存储适配（本地 / S3）

- 状态：提议（待复核）；**存储布局部分已由用户确认（2026-09-18），权威定义见 [spec.md §1](../spec.md)**
- 日期：2026-09-17
- 关联：ADR-0003、ADR-0006、ADR-0008

## 背景

源片、HLS 分片、字幕、缩略图需要存储；要求「本地或 S3 存储」均可；开发期希望零依赖（MinIO / 本地卷），生产用 **COS 私有桶（S3 兼容接口）+ EdgeOne CDN 加速域名 + 私有回源**。P0 纪律：**视频字节不经过云函数**，分片必须 CDN / 源站直出。

## 决策

`packages/storage` 定义统一 `StorageAdapter`：

```
Put / Get / Stat / Delete / List
PresignPut(key, ttl)        # 直传预签名
PresignGet(key, ttl)        # 下载 / 播放签名 URL
PublicUrl(key)              # 经 CDN 域名拼 URL
```

两个实现：

- `s3`：COS（S3 兼容）/ MinIO —— 生产与开发共用代码；
- `local`：本地文件系统（自托管 Compose；由管理端 / 分发端进程直接读写与流式供片）。

### 存储布局（键规范）

> 2026-09-18 用户定稿，取代本 ADR 早期 `raw/` / `hls/` / `sub/` / `thumb/` 布局；完整规范见 [spec.md §1](../spec.md)。

```
{root}/original/{id}.{ext}                          # 原始上传（一个媒资一个文件，{id} = 数字媒资 ID）
{root}/proceed/{id}/master.m3u8                     # 主清单模板（改写发生在分发端）
{root}/proceed/{id}/{variant}/index.m3u8            # 子清单
{root}/proceed/{id}/{variant}/seg-{n}.ts            # 分片（已 AES-128 加密）
{root}/proceed/{id}/subtitles/{trackId}.vtt         # 字幕
{root}/cover/{id}/poster.jpg                        # 海报 / 封面图
{root}/metadata/{id}/probe.json                     # ffprobe 系统元数据
{root}/metadata/{id}/custom.json                    # 业务扩展元数据
```

- `{root}` 为**全局 root 前缀**（`STORAGE_ROOT_PREFIX`，可不在桶根、可与其它业务共享桶，可为空）；由存储适配层统一拼接，业务代码与键常量只写相对键。
- 四分区：`original/`（原视频）、`proceed/`（转码与处理产物）、`cover/`（封面与图片）、`metadata/`（元数据）；数字媒资 ID（默认 8 位，长度可配）为全部资产的唯一索引。
- **密钥绝不入对象存储**：wrapped CEK、JWT 私钥只入数据库（ADR-0006 / 0007）。
- 桶策略：生产用私有桶，仅经签名 URL 或 CDN 鉴权访问。

### 上传路径

- v1：管理端后台上传 —— `PresignPut` 预签名直传（大文件走 S3 multipart 分片 / 断点续传），完成后登记媒资并入队探测 / 转码。
- 播放端不提供上传。

### 分片服务路径（两模式）

| 模式 | 机制 |
|---|---|
| s3 / CDN | **EdgeOne URL 鉴权 TypeA**（用户已定，2026-09-17）：COS 保持私有桶，EO 经**私有回源**取片；分发端用控制台配置的 TypeA 鉴权密钥生成签名 URL（`?sign=timestamp-rand-uid-md5(uri-timestamp-rand-uid-key)`）注入清单，CDN 边缘校验 |
| local | 分发端校验路径签名 token 后，从本地卷流式输出（自托管场景，带宽可控） |

### EdgeOne TypeA 约定

- 鉴权密钥与有效时长在 **EdgeOne 控制台**配置；同一密钥登记到 `signing_keys`（kind=edgeone_typea，MK 封装，ADR-0004 / 0007），分发端据此生成 URL，管理端负责轮换（轮换需与控制台同步双密钥窗口）。
- TypeA 的过期由「有效时长」控制：分发端生成的 timestamp + 控制台配置的时长共同决定有效期，**两侧配置必须一致**（写入部署文档，并加冒烟断言）。
- 上传与管理侧操作仍用 COS 预签名（S3 签名），与播放鉴权互不干扰。

## 理由

- S3 兼容接口让 COS / MinIO / 自建 MinIO 一套代码全兼容，正合「本地或 S3」需求。
- 密钥与内容分域（DB vs 对象存储）降低单点泄露面。

## 备选（否决 / 搁置）

- EdgeOne Pages Blob / KV 作视频主存储：定位为边缘小对象 —— 否决。
- 回源代理模式（函数转发分片）：违反「字节不过函数」P0 —— 否决（自托管 local 模式除外）。
- COS 预签名 URL 作播放分发 URL：可行但鉴权管理分散（S3 签名与 EO 边缘策略割裂）—— 否决（用户选定 EO TypeA）。

## 后果与风险

- TypeA 签名 URL 的 query 参与缓存键：不同会话生成的 rand 不同，首播回源一次后命中；有效时长在控制台配置（建议 ≥4h）以减少回源。
- TypeA 鉴权密钥为敏感材料：仅管理端与分发端持有（MK 封装入库）；私有回源下 COS 读凭据配置在 EO 侧，分发端无需持有 COS 读 SK（上传预签名凭据仍归管理端）。
- 键前缀分区即隔离：`original/` 仅管理端写；`proceed/`、`cover/`、`metadata/` 管理端与 Worker 写、分发端经 CDN/TypeA 读；单桶足够，不按应用拆桶（ADR-0011 约束 5）。
