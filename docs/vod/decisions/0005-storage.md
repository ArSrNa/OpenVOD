# ADR-0005：对象存储适配（S3 兼容）

- 状态：提议（待复核）；**存储布局部分已由用户确认（2026-09-18），权威定义见 [spec.md §1](../spec.md)**；**2026-09-20 用户修订：放弃 EdgeOne CDN TypeA（私有回源），分片定为 S3 预签名直出（字节不经过分发端）**；**2026-09-22 用户修订：放弃本地文件系统驱动，仅支持 S3 兼容对象存储**（见「分片服务路径」与「修订记录」）
- 日期：2026-09-17
- 关联：ADR-0003、ADR-0006、ADR-0008

## 背景

源片、HLS 分片、字幕、缩略图需要存储；生产用 **COS 私有桶（S3 兼容接口）**，开发期用 MinIO（同一套 S3 代码）；可前置任意 CDN 透传加速（2026-09-20 修订：不再绑定 EdgeOne 私有回源，见修订记录）。P0 纪律：**视频字节不经过云函数**，分片必须 CDN / 源站直出。

## 决策

`packages/storage` 定义统一 `StorageAdapter`：

```
Put / Get / Stat / Delete / List
PresignPut(key, ttl)        # 直传预签名
PresignGet(key, ttl)        # 下载 / 播放签名 URL（可经 STORAGE_CDN_BASE_URL 替换 origin）
```

唯一实现：

- `s3`：COS（S3 兼容）/ MinIO 等一切 S3 兼容对象存储 —— 生产与开发共用代码（本地开发起 MinIO 即可）。

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

### 分片服务路径

**S3 预签名直出**（2026-09-20 定稿，M3 已实现并端到端验证）：COS 保持私有桶，分发端以受限只读凭据生成预签名 GET URL（TTL 与播放会话对齐）注入清单，客户端直连对象存储取片、**字节不经过分发端**（P0）；可配 `STORAGE_CDN_BASE_URL` 把预签名 origin 替换为加速域名（CDN 回源 COS + Host 透传才可验签）。

### 修订记录

- **2026-10-17（EO 鉴权以 `cdn_url_auth` 重新纳入）**：本条 2026-09-20 的「放弃 EO TypeA」修订**部分改变**——ADR-0019（2026-10-06 定稿 / 2026-10-09 实现 / 2026-10-17 扩展）把 EO Token 鉴权以**管理端可配置的 `cdn_url_auth` 模式**重新纳入，官方 5 种方式（A/B/C/D/V）全内置（`storage_cdn_auth_type` 选择）；`EO_TYPEA_KEY` 环境变量与 `signing_keys.kind=EO_TYPEA` 仍为废弃载体（密钥改走 `storage_cdn_auth_key` / `STORAGE_CDN_AUTH_KEY`），s3 预签名仍为默认形态。详见 ADR-0019 与 spec.md §6.7。
- **2026-09-22（管理端首页存储统计）**：S3 首页只展示当前 root 下四个业务分区对象大小之和，不假设固定桶配额，不展示占用百分比或分区进度条；说明固定为「包含媒体、转码、字幕、元数据等产物」。统计复用适配器分页列举的对象元信息，不下载内容；同次请求复用于媒资 / 字幕 / 转码产物 / 元数据计数，具体口径见 spec.md §2.1 与 intent.md「控制台总览」。
- **2026-09-20（放弃 EO TypeA，s3 预签名转正）**：
  - 原 2026-09-17 决定：s3 形态采用 **EdgeOne URL 鉴权 TypeA**（COS 私有桶 + EO 私有回源；分发端持控制台同款密钥生成 `?sign=timestamp-rand-uid-md5(uri-timestamp-rand-uid-key)`，密钥入 `signing_keys.kind=EO_TYPEA`，轮换需与控制台同步双密钥窗口、有效时长两侧必须一致）。
  - **2026-09-20 用户修订**：不再使用 EdgeOne CDN。理由：TypeA 强绑定 EO 生态（控制台配置、密钥同步、轮换窗口），限制部署方自由选择 CDN / 存储组合；预签名方案厂商中立、开发与自托管零额外配置，且 M3 已实现并端到端验证。
  - TypeA 相关约定作废：`EO_TYPEA_KEY` 环境变量、`signing_keys.kind=EO_TYPEA` 与 `packages/crypto` 的 TypeA 签名实现保留为未接入链路的废弃代码（枚举清理需 expand-contract 迁移，另行处理）。
  - 上传与管理侧操作本就使用 COS 预签名（S3 签名），播放分发同源后不再有「两套鉴权体系」。
  - **二次修订（2026-09-20，用户定）**：~~曾短暂改为分发端代理默认（proxy）~~ **已回退**——分片一律 **S3 预签名直出**（字节不经过分发端，P0），不引入任何代理模式；`DELIVERY_SEGMENT_SERVE` 环境变量与相关代码已删除。播放域名（清单 / 密钥 / 字幕）仍可经 `system_settings.playback_base_url` 运行时覆盖（spec.md §2.1.2）；分片域名由 `STORAGE_CDN_BASE_URL` 加速域名承接（统一加速域名条目）。
  - **统一加速域名（2026-09-20，用户定方案 A）**：新增共享 env `STORAGE_CDN_BASE_URL`——配置后 **GET 预签名 URL 的 origin 替换**为加速域名（管理端 original / 封面预览 302、presign 模式分片直出；`packages/storage` s3 适配器与 Go `blob` 同源实现），路径与签名 query 原样保留，**上传预签名不受影响**。前提：该域名 CDN 回源 COS 且 Host 透传 / 改写为桶端点（SigV4 签名覆盖 Host），缓存按 query 不缓存或短 TTL。若需「一个域名收敛全部流量」：CDN 路径规则 `/v1/*` 回源分发端、其余回源 COS，播放域名与加速域名填同一值即可。
- **2026-09-22（放弃本地文件系统驱动，仅 S3）**：
  - **用户修订**：不再提供本地文件系统存储（原 `local` 驱动 / `LocalAdapter`），全系统只支持 S3 兼容对象存储；本地开发用 MinIO（`S3_FORCE_PATH_STYLE=true`）承载同一套代码。
  - 相关代码与环境变量已删除：`packages/storage/src/local.ts` 及其测试、Go `blob` 的 `localStore` / `OpenLocal` / `Driver()`、分发端 `/v1/media/{id}/segment/*` 代理路由（typ=s 分片流式输出）、管理端 original / 封面的 Range 流式代理分支（仅保留预签名 302）、`STORAGE_DRIVER` 与 `STORAGE_LOCAL_ROOT` 环境变量（存储恒为 S3，`S3_*` 五项为启动必需）。
  - 理由：函数 / 容器形态本就强制 S3（无共享卷 + 6MB 响应体上限），local 驱动只服务自托管 Compose 且长期处于「待补 / TODO」状态（poster 直出等），维护两套驱动分支的漂移成本高于收益；统一 S3 后播放链路只剩一条已验证路径。

## 理由

- S3 兼容接口让 COS / MinIO / 自建 MinIO 一套代码全兼容；仅保留单一驱动消除分支漂移。
- 密钥与内容分域（DB vs 对象存储）降低单点泄露面。

## 备选（否决 / 搁置）

- EdgeOne Pages Blob / KV 作视频主存储：定位为边缘小对象 —— 否决。
- 回源代理模式（函数转发分片）：违反「字节不过函数」P0 —— 否决。
- COS 预签名 URL 作播放分发 URL：~~2026-09-17 否决（原理由：S3 签名与 EO 边缘策略割裂）~~ —— **2026-09-20 转正为最终方案**（放弃 EO 后原否决理由不再成立；厂商中立、零控制台依赖）。
- EdgeOne URL 鉴权 TypeA（私有回源）：2026-09-17 曾选定 —— **2026-09-20 否决**：强绑定 EO 生态，控制台配置 / 密钥同步 / 双密钥轮换窗口抬高部署与运维成本，限制部署方自由选择 CDN。
- 本地文件系统驱动（自托管 Compose）：2026-09-17 曾保留 —— **2026-09-22 否决**：见修订记录；自托管场景用 MinIO 走同一 S3 代码。

## 后果与风险

- 预签名 URL 的 query 参与缓存键（CDN 透传场景）：不同会话签名不同，命中率低；分片多为一次顺序消费，影响可接受。追求命中率需内容版本化 + 共享 token，属远期演进。
- 分发端需持有 COS **受限只读凭据**（限 `proceed/`、`cover/`、`metadata/` 前缀读，用于生成播放预签名；ADR-0011 约束 4 随 2026-09-20 修订由「零读凭据」调整）；S3 **写**凭据仅管理端 / Worker 持有。
- 预签名 TTL 与播放会话对齐（≤ 会话 exp）；单条 URL 无中心吊销，吊销语义收敛在清单 / 会话层（typ=m token 逐会话签发，清单请求每会话校验）。
- 键前缀分区即隔离：`original/` 仅管理端写；`proceed/`、`cover/`、`metadata/` 管理端与 Worker 写、分发端经预签名读；单桶足够，不按应用拆桶（ADR-0011 约束 5）。
- Worker / 管理端取源片（ffprobe / ffmpeg 输入）一律走预签名 GET URL：转码依赖对象存储网络可达且带宽充足（字节虽不经分发端函数，但 Worker 转码机与存储间有源片读流量）。
