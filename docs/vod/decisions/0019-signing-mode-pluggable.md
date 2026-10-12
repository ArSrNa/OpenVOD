# ADR-0019：资产 URL 签名方式可插拔（S3 预签名 / CDN URL 鉴权 / 自定义提供者）

- 状态：已接受（2026-10-06 设计定稿；**2026-10-09 已实现**——落地记录见文末修订记录；`custom` 模式与 Agent 提示词生成机制为同日扩展）
- 日期：2026-10-06
- 关联：ADR-0005（2026-09-20 修订关闭 EO TypeA）、ADR-0006、ADR-0015（settings 机制）、ADR-0011；open-questions #3

## 背景

1. **现状（ADR-0005，2026-09-20 定稿）**：分片一律 S3 预签名直出（私有桶 + SigV4，字节不经过分发端）；可配 `STORAGE_CDN_BASE_URL` 做加速域名的 origin 替换。2026-09-20 同日关闭了 EdgeOne URL 鉴权 TypeA（私有回源 + CDN 签名），理由是「强绑定 EO 生态、限制部署方自由选择 CDN / 存储组合」。
2. **2026-10-05 实测踩坑**（回写 spec §6.5 / dev-workflow §8）：CDN 缓存键忽略查询串时，同路径重转码的产物永远读不到（陈旧分片），且无签名请求可命中缓存绕过 URL 鉴权（裸打分片 URL 返回 200）。临时用「存在 query 不缓存」止血。
3. **架构性两难**：预签名 query 每次播放都不同 → 缓存键含 query 则分片命中率恒为 0（CDN 退化为回源代理）；忽略 query 则正确性与鉴权双输。「CDN 加速 + URL 鉴权」在 presign 形态下不可兼得。
4. **部署方诉求**：签名形态（S3 预签名 / CDN 私有回源 + CDN 签名 / 其它 CDN 的自有鉴权）应当是**部署时的配置选择**而非代码分支；且允许自托管部署方接入自有签名实现。

## 决策

1. **GET 形态签名 URL 的生成方式升级为管理端可配置项**（ADR-0015 settings 机制，`storage` 组）：
   - `storage_sign_mode`：`s3_presign`（默认，现状）| `cdn_url_auth`；
   - `storage_cdn_auth_key`：CDN URL 鉴权密钥（secret，MK 封装存储，口径同 `url_sign_key_hex`；与 CDN 控制台同款密钥，双侧必须一致）；
   - `storage_cdn_auth_ttl_sec`：鉴权 URL 有效期（默认 3600；timestamp 按窗口对齐，窗口内 URL 稳定 = 缓存友好）；
   - `storage_cdn_base_url` 语义随模式：`s3_presign` 下为预签名 origin 替换（现状不变）；`cdn_url_auth` 下为签名 URL 的 host；
   - env 兜底 `STORAGE_SIGN_MODE` / `STORAGE_CDN_AUTH_KEY` / `STORAGE_CDN_AUTH_TTL_SEC`（ADR-0015）。
2. **不变量：桶恒为私有（ADR-0005 纪律，两种模式都不改变桶策略）——可变的只有「签名发生在 S3 还是 CDN」**。两种内置形态只是签名位置不同：
   - `s3_presign`（现状）：**签名在 S3**——SigV4 预签名 GET（query 即签名），CDN 纯透传，回源时由 S3 验签；缓存键必须含完整 query 或带 query 不缓存；
   - `cdn_url_auth`：**签名在 CDN**——CDN 配置**私有回源**（存储凭证配置在 CDN 控制台：EdgeOne「源站鉴权」/ COS 原生私有桶回源授权；URL 上**没有也不需要 S3 签名**，CDN 以自有凭证直接读取私有对象），边缘以 **CDN URL 鉴权**签名（v1 实现 EdgeOne TypeA：`?sign=timestamp-rand-uid-md5(uri-timestamp-rand-uid-key)`）；分发端 / 管理端不再对播放 URL 做 S3 签名，改签 CDN 鉴权 URL；
   - 由此推论：`cdn_url_auth` 下 admin **不配置任何存储回源凭证**——回源凭证是 CDN 控制台的部署配置，不入库；admin 只管边缘签名密钥（`storage_cdn_auth_key`）。
3. **签名提供者抽象（可插拔）**：统一语义 `sign(key, ttlSec) -> 绝对 URL`。
   - TS（`packages/storage`）：`UrlSigner`，`createStorage` 时按 settings 注入；Go（`apps/delivery/internal/blob`）：`URLSigner` 接口，装配包注入；
   - 内置实现：`s3_presign`（现有 presignGet 的签名段重构为接口实现）与 `edgeone_url_auth`（TypeA，`packages/crypto` 废弃实现为起点，先补 fixtures 再接入）；
   - **自定义提供者**：自托管自编译用户实现接口并在装配处注册（Go 编译期注入 / TS 工厂注入），覆盖非 EO 的 CDN / 存储组合；**运行时动态插件明确不做**（安全面与复杂度，理由同 ADR-0005 仅保留单一存储驱动）；
   - 文档义务：spec §6.7 给出契约、TypeA 算法与 fixtures 要求，使实现可由 AI / 开发照文档独立完成并自验。
4. **消费范围**：所有 GET 形态签名 URL 统一走提供者——分发端分片直出（spec §6.2）、管理端 original / 封面 / 水印图 302、Worker 取水印图（ffmpeg 输入）。清单 / 密钥 / 字幕内容仍走分发端自身 token（typ=m/k/v，§6.2 / §7.5），**不变**（它们是分发端函数路由，不经对象存储）。签名只改变「播放端可见的 URL 形态」：清单读取（`storage.get`）、上传 / 转码写路径仍走 S3 SDK，存储凭据面不变。
5. **缓存指引随模式**（写入部署文档）：`s3_presign` → 缓存键含完整 query 或带 query 不缓存（2026-10-05 口径）；`cdn_url_auth` → 缓存键含 query（TypeA 窗口内可命中），CDN TTL ≤ 签名窗口。
6. **切换运维**：settings 30s 快照生效、无需重启；在途会话已改写清单按旧模式有效至过期，新播放即时新模式；切换后 CDN 全量刷新一次。

## 理由

- **重开的真因与原否决理由不冲突**：2026-09-20 否决 TypeA 是因为「强绑定 EO、没有选择权」，不是鉴权形态本身有问题。把它做成「admin 驱动的可插拔签名方式之一 + 自定义提供者」，厂商中立性反而增强（EO 用户获得加速能力，非 EO 用户保持 presign 或写自己的实现）。
- **cdn_url_auth 解决 presign 的缓存死结**：TypeA URL 在时间窗口内稳定（timestamp 粒度 + 固定 rand/uid），同一窗口内跨用户跨会话可命中缓存，命中率从 0 变正；鉴权在 CDN 边缘生效，不再依赖「缓存键是否带 query」这类易错配置。
- **admin 驱动而非代码分支**：沿用 ADR-0015 的 settings 机制，模式切换不改代码、不重建镜像；密钥走 MK 封装与既有 secret 字段同口径。
- **文档先行**：契约 + 算法 + fixtures 要求先定稿（本 ADR + spec §6.7），实现可独立验证——与 contracts（生成物 diff 门禁）、crypto（共享向量）同一防漂移思路。

## 备选（否决 / 搁置）

- 维持现状 + 重转后手动刷新 CDN 缓存：2026-10-05 起的临时口径，不可扩展（每次重转码都要人工刷新），否决为长期方案；
- 分发端代理分片：违反「字节不过函数」P0（ADR-0005），不再讨论；
- 桶公有化免签：违反「桶恒私有」不变量（无鉴权），不成立——私有桶是前提而非选项；
- 运行时脚本 / 动态插件签名：把可执行代码引入配置面，安全面失控；
- 仅做「缓存键含 query」的部署指引而不改签名形态：即现状 `s3_presign`，保留为默认模式而非否决——只是命中率天花板为 0，部署方有加切实需求时自然迁移到 `cdn_url_auth`。

## 后果与风险

- **密钥面 +1**：CDN 鉴权密钥入 `system_settings`（MK 封装），且与 CDN 控制台双侧一致；轮换需短暂双密钥窗口（由部署方控制节奏）——这正是 2026-09-20 否决 TypeA 的运维成本点，v1 接受（单密钥、无自动轮换）；
- **TypeA 算法强依赖 EO 官方口径**：实现时必须以官方文档核对公式与参数（timestamp 精度、uri 口径、md5 明文拼接顺序），并产出 fixtures（本地实现 vs 官方示例向量）后再接入，防止「照记忆实现」；
- **分发端仍持 S3 受限只读凭据**：清单对象读取不走 CDN URL（`storage.get` 用 SDK）——密钥面不减，减少的是播放端可见 URL 的签名暴露与缓存耦合；
- **缓存键配置错误会回归 2026-10-05 踩坑**：deploy 文档必须给出两种模式各自的 CDN 控制台配置清单（缓存键 / TTL / 私有回源），作为切换前置条件；
- **模式切换过渡期**（≤ URL TTL）新旧形态并存：无破坏性，但旧形态缓存条目需刷新清退；
- **实现排期未定**：本 ADR 与 spec §6.7 为设计定稿，代码零改动；实现清单见下。

## 实现清单（后续 PR，本文档不落地）

1. `packages/storage`：`UrlSigner` + `s3PresignSigner`（重构现有 presignGet 签名段）+ `edgeoneTypeASigner` + 按 settings 的工厂 + TypeA fixtures；
2. Go `apps/delivery/internal/blob`：`URLSigner` 接口 + 两实现 + 装配（`app.LoadEdgeOneEnvironment` / settings 快照）；
3. `packages/contracts` / settings schema：新键定义与校验（枚举、ttl 范围、key 形状）；
4. 管理端设置 UI：`storage` 组新字段（secret 字段 MK 封装读写，对齐 `url_sign_key_hex`）；`api.md` §1.8 分组字段随实现补录；
5. 部署文档：两模式各自的 CDN 控制台配置清单（缓存键 / TTL / 私有回源 / Token 鉴权开关）。

## 修订记录

- **2026-10-09（实现落地 + `custom` 扩展）**：
  1. **实现落地**：storage（`packages/storage/src/signer.ts`）与 Go（`apps/delivery/internal/blob/signer.go`）双侧 `UrlSigner` / `URLSigner` 抽象与 `s3_presign` / `cdn_url_auth` 内置实现；TypeA 经 EO 官方文档核对（**timestamp 为十进制** Unix 秒）并产出共享 fixtures `packages/crypto/fixtures/url-sign-v1.json`（含官方示例向量，TS / Go 测试同源防漂移）；设置键登记于 `packages/shared`（本仓 settings 机制实际不经 contracts schema，实现清单第 3 项据此调整）；管理端设置 UI（storage 组四字段 + 保存组合校验）+ `api.md` §1.8 补录 + env 兜底 `STORAGE_SIGN_MODE` / `STORAGE_CDN_AUTH_KEY` / `STORAGE_CDN_AUTH_TTL_SEC` / `STORAGE_CUSTOM_SIGNER`；
  2. **`storage_sign_mode` 增加 `custom` 取值（超出原文档 `s3_presign | cdn_url_auth` 的扩展）**：自定义提供者仍为**编译期注册**（TS `packages/storage/src/custom-signer.ts` 的 `registerUrlSigner`、Go `apps/delivery/internal/blob/custom_signer.go` 的 `RegisterURLSigner`，注册名 = `storage_custom_signer`），不违反「运行时动态插件明确不做」的决策；
  3. **Agent 提示词生成（同日新增的用户需求）**：管理端「存储设置」在 sign mode 为 `custom` 时提供提示词生成器（`apps/admin/src/lib/custom-signer-prompt.ts`）——用户可补充自己的 CDN 鉴权算法说明，一键复制提示词交给自己的 AI 编码助手，在两个注册点生成双语言实现与互通测试。边界纪律：提示词只含设置键名与契约、**绝不携带密钥材料**；生成代码要求密钥经 env / settings 注入、禁止硬编码；产物仍需重新构建部署（等价于用户自编译注册，安全面不扩大）；
  4. `cdn_url_auth` 语义补充：`sign()` 的窗口恒取 `storage_cdn_auth_ttl_sec`（调用方 ttl 忽略）——这是「窗口内 URL 稳定 = 缓存键稳定」的前提；需更长有效期就调大该设置并同步 CDN 控制台（spec.md §6.7）。
- **2026-10-06（本文档）**：重开 2026-09-20 关闭的 EO TypeA（open-questions #3、ADR-0005 修订），升级为「admin 驱动的可插拔签名方式」；触发点为 2026-10-05 CDN 陈旧缓存与鉴权绕过实测（spec §6.5）。
