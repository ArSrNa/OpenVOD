# Intent — OpenVOD 播放器 SDK（Player SDK）

- 日期：2026-10-13
- 状态：已实现（2026-10-16：`packages/player-sdk` + `apps/player` 接入；规范见 [player-sdk-spec.md](./player-sdk-spec.md)；体验环境端到端验收 S3 待执行）
- 关联：ADR-0006（加密与播放密钥）、ADR-0007（鉴权与用户体系）、ADR-0010（分发端 API 面）、[spec.md](./spec.md) §6（播放链路）/ §7.5（字幕）/ §11（播放演示 App）、[api.md](./api.md) §2（分发端 API）

## 一句话

把「delivery 地址 + 播放账号」到「可播放的签名 URL」的整条接入链路收敛为一个**零依赖 TypeScript 包**：宿主 App（Web / Node / RN 同源实现）初始化后即可拿到带签名的 m3u8；token 续期、会话重签、清晰度切换、字幕下发由 SDK 治理，业务代码不接触任何签名与鉴权细节。

## 为什么做（背景）

- M3/M4 播放链路（login → play → 清单改写 → key → 字幕）已跑通，但**每个播放端接入方都要重写同一套客户端逻辑**：登录换 JWT、`play` 换签名主清单 URL、401 重登、403 `bad_token` 重新 play、会话复用——`apps/player` 的 `lib/delivery.ts`（约 180 行）是第一次重写，第二次重写就会漂移。
- 接入的难点不在 HTTP，而在**生命周期**：JWT 默认 24h 且**无 refresh**（ADR-0007）；播放会话默认 4h；清单 token `exp = min(now + ManifestTTL, 会话 exp)`；会话可被管理端吊销并即时收敛（每请求查库）。任何一处处理不当，表现都是「播到一半黑屏 / 长视频后段 403」，且接入方难以定位。
- 目标用户是**接入方开发者**（App / Web 播放器团队）：他们只应关心「拿 URL 喂播放器」与业务 UI，不应理解 token 分层与 signing mode（ADR-0019）。

## 用户给出的核心需求（2026-10-13，权威）

1. 面向播放端 App / 播放器提供 SDK，方便从播放器接入 delivery；
2. **最基础能力**：登录获取 token、获取签名视频 URL（m3u8）；
3. **接入体验**：初始化只填 delivery 地址 + 用户名 / 口令即可完成签名（拿到可播放的签名 URL）；
4. 在此之上扩展设计更多能力；
5. 设计先行：本文件与 [player-sdk-spec.md](./player-sdk-spec.md) 是权威设计，暂不写代码。

## 用户拍板的设计边界（2026-10-13 问答）

| 问题 | 决策 |
|---|---|
| 平台范围 | **仅 TS/Web**（包形态交付，浏览器优先、Node 兼容）；Android / iOS 后续再议 |
| 播放器集成深度 | **纯核心、播放器无关**——只输出签名 manifest URL / 元数据 / 事件；宿主自己喂给 hls.js、ExoPlayer、AVPlayer |
| 扩展功能（v1） | **自动续期 / 重签**（JWT 过期自动重登、会话 / token 过期自动重新 play）+ **清晰度切换**（`templates[]` 复用会话换源） |
| 鉴权模式（v1） | 四种全支持：**用户名口令**（基线）/ **外部 tokenProvider** / **直接注入 JWT·URL** / **多账号热切换** |

> 未选入 v1 的候选：事件诊断系统（卡顿 / CORS 根因提示）、播放进度持久化 / 断点续播——SDK 仍提供最小事件集与 `expires_at` 等可观测点，诊断保留在消费方（`apps/player`）实现。

## 目标

### 功能目标

- **一行初始化**：`createPlayerSdk({ baseUrl, credential })` —— delivery 地址 + 播放账号口令即完成接入；SDK 内部完成 login、token 缓存与到期重登；
- **签名 URL 获取**：`play(mediaId)` 返回播放句柄（`manifest_url` / `sid` / `expires_at` / `template_id` / `subtitles[]` / `templates[]`），清单 / 密钥 / 分片的签名信息全部已带在 URL 上，宿主直接喂播放器；
- **媒资浏览**：`listMedia()` / `getMedia(id)`（probe、就绪字幕轨道、`custom` 公开白名单的防御性解析）；
- **生命周期治理（核心卖点）**：JWT 到期前自动重登（401 兜底重试一次）；会话 / 清单 token 到期前自动重新 play 重签（403 兜底）；失败可观测 + 手动 `refresh()` 逃生舱；
- **清晰度切换**：`handle.switchTemplate(templateId)` 复用会话换源（不新建会话、不额外消耗并发额度）；
- **字幕**：轨道元信息与签名 URL 随句柄下发；提供 VTT 文本拉取辅助（挂载方式由宿主 / 播放器决定）；
- **四种鉴权模式**：口令 / tokenProvider（宿主后端换 JWT，凭据不下终端）/ static JWT / attach 已有签名 URL（零请求接管）；`setCredential()` 支持运行时身份热切换（多用户 App 场景）。

### 非功能目标

- **零运行时依赖**：仅用 `fetch`（可注入）；浏览器 / Node 18+ / RN 同一份实现；不打包任何播放器库；
- **零后端改动**：只消费既有 `/v1` API（ADR-0010），不新增端点、不改契约、不改 DB；
- **不做语义复制**：SDK 不复制服务端业务校验（`limit` 回退、模板自动选择、会话复用、token 校验一律以服务端为准），避免双份语义漂移；
- **P0 纪律不放松**：SDK 永不接触 CEK / 分片字节 / MK / 服务端签名密钥，不引入任何「客户端本地签名」；加密解密保持由播放器内核原生完成（ADR-0006 §6.2）；
- **可测试**：`fetch` 可注入 + 时钟可注入，单测覆盖全部生命周期分支（无网络、无真实 delivery）。

## 核心使用流程（接入方视角，权威）

```ts
import { createPlayerSdk } from "@openvod/player-sdk";

const sdk = createPlayerSdk({
  baseUrl: "https://vod.example.com",                 // delivery 地址
  credential: { mode: "password", username: "demo", password: "******" },
});

const handle = await sdk.play("55395830");            // login（自动）→ play（自动）
video.src = handle.manifestUrl;                       // 完成签名：清单 / 密钥 / 分片全链路已带签名

// 长播放 / token 到期前，SDK 自动重签并通知（换源由宿主执行，v1 不含播放器适配器）
sdk.on("playback:refreshed", (e) => {
  if (e.mediaId === "55395830") video.src = e.manifestUrl;
});

// 清晰度切换：复用会话，换源后由宿主保留播放进度
await handle.switchTemplate(templateId);
```

## 非目标（v1 明确不做）

- Android / iOS / Flutter / 小程序 SDK 包（v1 仅 TS/Web；跨端移植以 spec 的协议层行为为蓝本，后续再议）；
- 播放器适配器与 UI（hls.js / Video.js / ExoPlayer / AVPlayer 封装、皮肤、清晰度 / 字幕菜单组件）——v1 纯核心，宿主自行接线；
- 播放进度持久化 / 服务端进度上报 / 断点续播；
- 诊断提示系统（8s 卡顿、CORS 根因提示等）——保留在消费方实现；
- 预取 / 秒开优化 / 离线下载 / DRM / 直播；
- npm 公开发布流水线与独立版本号（仓库「版本号唯一真源」规则见 spec §13 开放问题）；
- 管理端能力（上传 / 转码 / 用户管理 / 密钥管理）——SDK 只做播放面；
- 服务端新增端点（含会话主动释放、token refresh）——v1 零后端改动；
- 任何形式的客户端解密 / 密钥材料接触（P0）。

## 成功标准（按竖切验收）

| 里程碑 | 验收内容 |
|---|---|
| S1 | `packages/player-sdk` 落地：公共 API + 四种鉴权 + 生命周期治理；注入 `fetch` 的单测矩阵全绿（登录 / 401 重登 / 403 重签 / 会话复用 / 并发去重 / 自动续签 / 多账号切换 / attach 模式）；类型与 `packages/contracts` 编译期对齐 |
| S2 | `apps/player` 改造为 SDK 首个消费者（tokenProvider 模式，凭据仍不下发浏览器）：列表 / 播放 / 清晰度切换 / 字幕行为回归，本地 `lib/delivery.ts` 接入逻辑收敛进 SDK |
| S3 | 体验环境端到端：SDK 产出的 `manifest_url` 以 ffprobe 直播（加密媒资解出同步字节）；伪造过期 JWT → 自动重登；伪造过期 token → 自动重签；多账号热切换生效 |
| S4 | 文档：`packages/player-sdk/README.md`（快速开始 / 生命周期说明 / 常见故障处置 / 片段）；本 intent / spec 与 README 索引互链 |

## 约束

- 平台事实与错误码以 ADR-0010 / [api.md](./api.md) §2 为准；生命周期语义以 [spec.md](./spec.md) §6.1 / §6.2 与 ADR-0006 §6 为准；
- 唯一版本号真源是根 `package.json`（仓库规则）：SDK 作为 workspace 包不声明 `version`，不提前引入独立发版机制；
- 契约唯一真相源是 `packages/contracts`：SDK 公共类型以 type-only 引用对齐，禁止手抄字段造成漂移；
- v1 无 refresh token（ADR-0007 现状）：SDK 的重登一律使用配置的凭据源重新 login，不假设其它续期机制。
