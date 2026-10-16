# Specification — OpenVOD 播放器 SDK（Player SDK，TS/Web）

- 日期：2026-10-13
- 状态：已实现（2026-10-16；意图与范围见 [player-sdk-intent.md](./player-sdk-intent.md)）
- 决策源：ADR-0006（加密与播放密钥）· ADR-0007（鉴权与用户体系）· ADR-0010（分发端 API 面）· ADR-0019（资产 URL 签名方式，对 SDK 透明）
- 规范源：[spec.md](./spec.md) §6（播放链路）· §6.3（模板产物选择）· §7.5（字幕）· §11.1（`templates[]`）· [api.md](./api.md) §2（分发端 API 参考）
- 范围：**仅消费既有 `/v1` API，零后端改动**；纯客户端包（浏览器优先，Node 18+ 兼容），不打包播放器库。

---

## 0. 定位与不变量

播放器 SDK 是 `apps/delivery` `/v1` API 的**官方客户端实现**（播放面），供接入方 App / Web 播放器使用。

不变量（设计红线，任何版本不得违反）：

| # | 不变量 | 理由 |
|---|---|---|
| N1 | **SDK 永不接触视频字节与密钥材料**：不下载分片、不请求 `/key`、不持有 CEK / MK | P0 纪律：分片字节不经函数、CEK 只由播放器内核经签名 key URL 获取并本地解密（ADR-0006 §6.2） |
| N2 | **SDK 不本地生成 / 校验 / 改写任何签名**：所有签名 URL 一律来自 `play` 响应原样透出 | token 自包含 HMAC-SHA256，客户端无密钥；改写即破坏鉴权（ADR-0006 §4） |
| N3 | **业务语义以服务端为准**：SDK 不复制服务端校验（`limit` 回退、模板自动选择、会话复用、token 校验） | 契约唯一真相源（ADR-0001 / 0010），双份语义必然漂移 |
| N4 | **错误保真**：服务端错误码 / 文案 / HTTP 状态原样透出；SDK 附加 `hint` 不得覆盖 `message` | 接入方按 `api.md` §2 错误码表排障，SDK 不得制造第二套词汇 |
| N5 | **重登一律经配置的凭据源重新 login**（v1 无 refresh token） | ADR-0007 现状；不假设任何续期机制 |

---

## 1. 包与工程形态

- 位置：`packages/player-sdk`；包名 `@openvod/player-sdk`；`"private": true`（v1 不发布 npm，见 §13），`exports: { ".": "./src/index.ts" }`（与 `packages/shared` 同形，workspace 直引源码）；
- **零运行时依赖**：只用 `fetch`（可注入）；浏览器 / Node 18+ / React Native 同一份实现；不 import 任何播放器库；
- 类型层以 **type-only** 引用 `@openvod/contracts`（`MediaListItem` / `MediaDetail` / `PageResponse` / `PlaybackRequest` / `PlaybackResponse` / `PlaybackSubtitleDTO` / `PlaybackTemplateDTO` / `ErrorCode`）——编译期与契约对齐，运行时零负担；
- 测试：`bun test`；全部用例注入 fetch stub 与假时钟，**无真实网络、无真实 delivery 依赖**；
- 首个消费者：`apps/player`（S2 验收，见 §12.3）。

目录初稿：

```
packages/player-sdk/
  package.json            # @openvod/player-sdk, type: module, private
  src/index.ts            # createPlayerSdk 入口 + 公共类型 / 辅助函数导出
  src/config.ts           # 配置校验与默认值（sdk_invalid_config）
  src/client.ts           # HTTP 传输：baseUrl 规范化 / fetch 注入 / 超时 / 错误信封解析
  src/auth.ts             # 四种凭据源 / token 缓存 / single-flight 重登 / storage 注入
  src/media.ts            # listMedia / getMedia / parseCustomMetadata
  src/playback.ts         # play / handle / 会话缓存 / 自动续签调度 / 串行化
  src/subtitles.ts        # 字幕轨道提取 / VTT 文本拉取
  src/events.ts           # 事件类型与订阅（监听器异常隔离）
  src/errors.ts           # DeliveryError / PlayerSdkError / 错误文案辅助
  test/*.test.ts          # §12.1 单测矩阵
  README.md               # 快速开始 / 生命周期 / 故障处置（S4 交付物）
```

---

## 2. 公共 API

### 2.1 命名与映射原则（零映射）

| 对象 | 规则 |
|---|---|
| **数据字段**（响应 DTO、handle、事件 payload） | 与契约 / `api.md` **逐字一致**（snake_case，如 `manifest_url` / `expires_at` / `template_id` / `is_default`）——零映射、可直接对照文档与抓包 |
| **方法名 / 配置项 / 局部参数** | camelCase（TS 惯例）：`play` / `switchTemplate` / `baseUrl` / `timeoutMs` |
| **请求体组装** | 单点映射（`templateId` → `template_id`）；以契约 `PlaybackRequest` 类型约束，编译期防漂移 |

### 2.2 入口与配置

```ts
import {
  createPlayerSdk,
  DeliveryError,
  PlayerSdkError,
  parseCustomMetadata,
  templateLabel,
  type PlayerSdk,
  type PlayerSdkConfig,
  type CredentialSource,
  type PlaybackHandle,
  type PlayerSdkEvent,
  type PlayerSdkStorage,
} from "@openvod/player-sdk";

export interface PlayerSdkConfig {
  /** delivery 基址（必填；仅 http/https，自动去尾斜杠） */
  baseUrl: string;
  /** 凭据源；缺省 = attach 模式（仅 attachPlayback 可用） */
  credential?: CredentialSource;
  /** 注入 fetch（RN / 测试 / 自定义代理）；缺省 globalThis.fetch */
  fetch?: FetchLike;
  /** 单请求超时（ms），缺省 10000 */
  timeoutMs?: number;
  /** 幂等 GET 的网络层重试次数（不含 §4.4 的 401 / 403 流程），缺省 0 */
  retries?: number;
  /** JWT 到期前多久触发重登（秒），缺省 300 */
  jwtRefreshLeewaySec?: number;
  /** 会话 / 清单 token 到期前多久触发自动重签（秒），缺省 300 */
  refreshLeewaySec?: number;
  /** 到期前自动重签（§4.3），缺省 true */
  autoRefresh?: boolean;
  /** JWT 持久化注入（§3.4）；缺省纯内存 */
  storage?: PlayerSdkStorage;
  /** 全局事件监听（等价 sdk.on(listener)） */
  onEvent?: (event: PlayerSdkEvent) => void;
}
```

`createPlayerSdk(config)` **同步构造、零网络请求**；配置非法抛 `PlayerSdkError("sdk_invalid_config")`。

### 2.3 完整方法签名

```ts
export interface PlayerSdk {
  readonly auth: {
    /** 取有效 JWT：缓存命中零请求；到期前按 jwtRefreshLeewaySec 重登；401 强制重登（§4.4） */
    getAccessToken(options?: { force?: boolean }): Promise<string>;
    /** 运行时切换身份：清 token / 会话缓存 / 定时器，旧句柄全部失效（§3.5） */
    setCredential(source: CredentialSource | null): void;
  };

  /** 媒资列表（GET /v1/media；恒为 READY；next_cursor v1 恒 null，透传） */
  listMedia(options?: { limit?: number; signal?: AbortSignal }): Promise<PageResponse>;
  /** 媒资详情（GET /v1/media/{id}；非 READY 仍返回详情，playable=false） */
  getMedia(mediaId: string, options?: { signal?: AbortSignal }): Promise<MediaDetail>;

  /** 建 / 复用播放会话并签发签名 URL（§4.1 / §4.2）；同媒资默认命中本地缓存（零请求） */
  play(mediaId: string, options?: PlayOptions): Promise<PlaybackHandle>;
  /** 接管已有签名 URL：零请求（§5.4）；无 credential 时 refresh / switchTemplate 抛 sdk_no_credential */
  attachPlayback(descriptor: AttachedPlayback): PlaybackHandle;

  /** 事件订阅；返回取消函数 */
  on(type: PlayerSdkEvent["type"], listener: (event: PlayerSdkEvent) => void): () => void;
  on(listener: (event: PlayerSdkEvent) => void): () => void;
  /** 清全部定时器与缓存（不释放服务端会话） */
  dispose(): void;
}

export interface PlayOptions {
  /** 指定模板产物（proceed/{id}/{templateId}/）；缺省按服务端自动选择（spec.md §6.3） */
  templateId?: string | null;
  /** 强制新建会话（仍受并发上限约束，§4.5）；缺省复用 */
  forceNew?: boolean;
  signal?: AbortSignal;
}

export interface PlaybackHandle {
  /** SDK 字段：play 传入的媒资 ID（服务端无此 wire 字段） */
  readonly media_id: string;
  /** 以下字段与 play 响应逐字一致（spec.md §6.1 / §11.1） */
  readonly sid: string;
  readonly manifest_url: string;
  readonly expires_at: string;      // ISO 8601（会话到期时间）
  readonly template_id: string;     // "" = 旧布局
  readonly subtitles: PlaybackSubtitle[];
  readonly templates: PlaybackTemplate[];
  /** SDK 字段 */
  readonly disposed: boolean;

  /** 复用会话换源：指定另一套模板产物（§5）；返回同一 handle（视图更新） */
  switchTemplate(templateId: string, options?: { signal?: AbortSignal }): Promise<PlaybackHandle>;
  /** 重新签发（复用会话）：force=true 跳过本地缓存强制请求 */
  refresh(options?: { force?: boolean; signal?: AbortSignal }): Promise<PlaybackHandle>;
  /** 停自动续签 + 本地失效（服务端无释放端点，会话按 TTL 自然过期，§4.6） */
  dispose(): void;
}

export interface AttachedPlayback {
  media_id: string;
  manifest_url: string;
  expires_at?: string;
  sid?: string;
  template_id?: string;
  subtitles?: PlaybackSubtitle[];
  templates?: PlaybackTemplate[];
}
```

`PlaybackHandle` 为**可更新视图**（同一媒资同一实例，getter 读取最新值）；`switchTemplate` / `refresh` 原位更新并返回自身，宿主无需替换引用。

---

## 3. 鉴权

### 3.1 凭据源（四种模式）

| 模式 | 配置 | login 触发 | 到期策略 | 适用 |
|---|---|---|---|---|
| `password` | `{ mode:"password", username, password }` | 首次 API 调用（懒加载，零后台定时器） | 本地到期前 `jwtRefreshLeewaySec` 重登；401 强制重登 | 快速接入 / 内网 / 演示；**凭据在终端** |
| `tokenProvider` | `{ mode:"tokenProvider", getToken }` | 首次 API 调用 | `getToken` 返回带 `expires_at` 时按 leeway 重取；返回裸 token（TTL 未知）时缓存至 401 重取 | **生产推荐**：宿主后端换 JWT，凭据不下终端 |
| `static` | `{ mode:"static", token, expires_at? }` | 无 | 401 直接失败（无重登能力）：抛 `DeliveryError` + 事件 `auth:changed{reason:"expired"}` | 已有会话注入 / 调试 / 服务端渲染 |
| attach | 不配置 `credential` | 不适用 | 无（纯 URL 透传，零请求） | 已有签名 URL（§5.4） |

- `tokenProvider.getToken` 可返回 `string` 或 `{ access_token, expires_at? }`（`expires_at` 支持 ISO 8601 或 Unix 秒）；
- login 请求 / 响应字段与 `api.md` §2.0 逐字一致（`{username,password}` → `{access_token, token_type, expires_in, kid}`）；SDK 由 `expires_in` 推算本地到期时刻，**不解析 JWT 内容**（JWT 仅作 opaque 字符串）；
- `tokenProvider` 的 `getToken` 与 login 共用 **single-flight**：并发调用只发起一次。

### 3.2 token 缓存与重登

- 缓存键 = 当前身份；命中且在到期前 `jwtRefreshLeewaySec` 之外 → 零请求返回；
- 进入 leeway 窗口 / `force:true` / 收到 401 → 走凭据源重新获取 → 覆盖缓存 → emit `auth:changed{reason:"refresh"}`；
- `password` 模式重登失败（`invalid_credentials`）→ 抛 `DeliveryError`（**不清空**配置凭据，允许宿主改口令后重试 `setCredential`）；
- 无后台定时器：JWT 只服务业务 API（list / detail / play），播放本身不依赖 JWT，采用**请求时懒刷新**（避免空闲 App 的无谓请求）。

### 3.3 请求鉴权头

所有 `/v1/media*` 请求带 `Authorization: Bearer <JWT>`（`api.md` §0.1）；清单 / 密钥 / 字幕 / 分片 URL **由 SDK 原样透出、不附加任何请求头**——这些资源经 URL query token 鉴权（Safari 原生 HLS 约束，ADR-0006）。

### 3.4 持久化（可选注入）

```ts
export interface PlayerSdkStorage {
  get(key: string): string | null | Promise<string | null>;
  set(key: string, value: string): void | Promise<void>;
  remove(key: string): void | Promise<void>;
}
```

- 默认**纯内存**；SDK 不内置 `localStorage`（XSS 面，安全责任交宿主显式选择）；
- 仅存 `{ access_token, expires_at, identity }`，键 `openvod.player-sdk.token`；**绝不存口令、播放 URL、会话信息**；
- 读取时校验形状，脏数据丢弃并静默重登；`setCredential` / 重登覆盖写。

### 3.5 多账号与身份热切换

- 一个 SDK 实例同一时刻**只有一个身份**；`setCredential(source)` 切换时：清 token → 清会话缓存 → 停全部自动续签定时器 → 旧句柄 `disposed=true` → emit `auth:changed{reason:"switched"}`；
- 多身份**并发**场景（同一 App 同时播两个账号的媒资）→ 使用多个 SDK 实例（各自持有句柄与定时器），文档给出建议；SDK 不提供实例间协调。

---

## 4. 播放会话与生命周期治理（核心）

### 4.1 会话模型（服务端语义摘录，权威在 spec.md §6.1 / ADR-0006）

- `play` 幂等：同用户 + 同媒资**未过期且未吊销**的会话默认复用（`ORDER BY created_at DESC LIMIT 1`）；
- 会话 TTL 默认 4h（`PLAYBACK_SESSION_TTL_SEC`）；吊销（管理端封禁 / 重置口令 / 手动踢下线）**即时收敛**（分发端每请求查库）；
- `manifest_url` 的 token `exp = min(now + ManifestTTL, 会话 exp)`；字幕 token `exp = min(now + SubtitleTTL, 会话 exp)`；
- 分片 URL 为存储签名直出（`s3_presign` / `cdn_url_auth`，ADR-0019），其有效期 = `ManifestTTL`（≤4h）；**子清单是一次性拉取的**，后段分片 URL 过期后播放会失败——自动重签（§4.3）同时解决 token 与分片预签名过期。

### 4.2 `play` 的本地缓存语义

| 情形 | 行为 | 网络调用 |
|---|---|---|
| 同媒资已有 handle 且 `expires_at - refreshLeewaySec > now`，未指定 `templateId` / `forceNew` | 直接返回缓存 handle | 无 |
| 指定 `templateId` 且等于当前 `template_id` | 空操作返回当前 handle | 无 |
| 指定不同 `templateId` | 调 `play`（复用会话）→ 更新 handle → emit `playback:template_changed` | 1 次 |
| 缓存缺失 / 即将过期（进入 leeway）/ `forceNew` / `refresh({force:true})` | 调 `play` → 更新 handle | 1 次 |
| 同媒资并发调用（play / refresh / switchTemplate 任意组合） | **共享同一 in-flight promise**（single-flight），完成后按序应用 | ≤1 次 |

### 4.3 自动续签（`autoRefresh`，默认开启）

1. 每次成功 `play` 后计算重签时刻：`t = min(manifest token exp, expires_at) - refreshLeewaySec`；
   - manifest token exp 由 SDK 解析 `manifest_url` 的 query `t` 载荷（base64url JSON 的 `exp`，**仅作调度用途、不验签、不用于任何安全判断**）；解析失败回退 `expires_at`；
2. 到点触发 `play`（复用会话，不新建、不消耗并发额度）→ 更新 handle → emit `playback:refreshed{reason:"auto"}` → 重新排程；
3. 失败 → 30s 后重试一次 → 仍失败 emit `error{operation:"auto_refresh"}` 并**停止自动**（防故障放大；宿主可手动 `refresh()`）；
4. `autoRefresh:false` → 不排程，宿主依据 `handle.expires_at` 自行 `refresh()`；
5. 定时器在 Node 环境调用 `unref?.()`（不阻塞进程退出）；`dispose` / 身份切换即清除。

> 无适配器（v1）下，宿主应监听 `playback:refreshed` 并把新 `manifest_url` 换源；换源后的进度保留属宿主职责（§5.2 给出参考做法）。

### 4.4 401 / 403 兜底

| 触发 | SDK 行为 | 上限 |
|---|---|---|
| 任意业务请求返回 401 `unauthorized` | 强制重登一次 → 重试原请求 | 每请求仅一次；二次 401 → 抛错 + `auth:changed{reason:"expired"}`（`static` 模式不重登，直接抛） |
| SDK 发起的资源请求（如字幕 VTT 拉取）返回 403 `bad_token` | `refresh()`（复用会话重签）→ 用新 URL 重试一次 | 每请求仅一次 |
| 播放器内部的清单 / 密钥 / 分片请求 403（SDK 不可见） | SDK **无法感知**：宿主应在播放器错误回调中调用 `handle.refresh()` 换源 | 责任边界见附录 B 与 README 处置片段 |

### 4.5 `forceNew` 与并发上限（易错点，必须澄清）

- 并发上限（`users.max_concurrent_sessions`，0=不限）**只在新建会话时检查**；命中返回 409 `session_limit`（`api.md` §2.2）；
- **`force_new` 不绕过上限**：分发端实现为先跳过复用、再走 `CountActiveSessions` 检查（`apps/delivery/internal/server/server.go` 播放处理器），达到上限时同样 409；
- SDK 不实现配额管理；透传错误 + `hint`（建议：等待旧会话过期 / 在管理端调大该用户并发上限 / 跨媒资会话会累积占用额度）。

### 4.6 `dispose` 与释放语义

- v1 分发端**无会话释放端点**（ADR-0010 未定义）：`handle.dispose()` / `sdk.dispose()` 仅停定时器、清本地缓存，服务端会话按 TTL 自然过期（额度同步释放）；
- 主动释放端点列入演进项（§13 Q1）。

---

## 5. 清晰度切换与接管模式

### 5.1 数据源与规则

- 选项 = `play` 响应 `templates[]`（「该媒资实际存在的模板产物」，spec.md §11.1）——`name` 可为 `null`（模板行已删）；`is_default` 仅展示；未指定 `templateId` 时播放的是 `templates[0]`（服务端自动选择 = 排序首项，§6.3）；
- SDK 提供 `templateLabel(t)` 辅助：`t.name ?? \`模板 ${t.id.slice(0, 8)}\``；
- 旧布局（`templates: []` 且 `template_id: ""`）不参与切换，宿主自行给出占位 UI。

### 5.2 `switchTemplate(templateId)`

- 复用会话重新 `play`（`spec.md §11.1` 的「切换」语义）；成功 → 原位更新 handle（`manifest_url` / `template_id` / `subtitles`）→ emit `playback:template_changed`；
- **失败不打断当前播放**：SDK 不改变现有 handle，抛错由宿主提示（apps/player 现有行为，作为验收基线）；
- 进度保留属宿主职责（v1 无播放器适配器）。参考做法（README 收纳）：切换前记录 `currentTime` 与暂停态 → 换源 → `loadedmetadata` 时 seek 恢复，失败静默从头。

### 5.3 同媒资操作串行化

`play` / `refresh` / `switchTemplate` 对同媒资**串行执行**（内部队列）；不同媒资可并发。避免「切换 + 自动续签」竞态导致 handle 被旧响应覆盖。

### 5.4 `attachPlayback`（已有签名 URL 接管）

- 零请求：仅注册 handle（数据字段原样透出）；用于「宿主已自行拿到签名 URL」或「纯播放器壳」场景；
- 配置了 `credential` 时：`refresh()` / `switchTemplate()` 可行（走真实 `play`，从此进入常规会话管理，`sid` 以服务端返回为准）；
- 未配置 `credential`：上述方法抛 `PlayerSdkError("sdk_no_credential")`；
- 无 `expires_at` → 不排程自动续签（无到期信息）。

---

## 6. 字幕

- 轨道数据随 `handle.subtitles` 下发：`{ id, lang, label, is_default, url }`（同一枚 `typ=v` token 覆盖全部轨道；`url` 已带签名，spec.md §7.5）；
- `fetchSubtitleText(track: PlaybackSubtitle, options?: { signal? })`：GET `track.url` → `text/vtt` 文本（响应 `no-store`，**SDK 不缓存**）；供宿主自行挂载或做文本处理；
- 挂载方式由宿主 / 播放器决定（`<track>` / hls.js `addTextTrack` / ExoPlayer `MediaItem.SubtitleConfiguration`）；**换源 / 重签后 URL 变化，宿主必须以新 handle 重建轨道**（原生 `<track>` 改 `src` 不自动重载——apps/player 已有此经验）；
- SDK 不做：字幕解析 / 重排 / 翻译 / 样式。

---

## 7. 媒资与自定义元数据

- `listMedia({ limit })`：**透传** `limit`（服务端缺省 50、1..200、非法静默回退，api.md §2.1）；SDK 不复制该校验（N3）；`next_cursor` 原样返回（v1 恒 `null`）并文档注明；
- `getMedia(mediaId)`：`probe` / `subtitles`（元信息，无 URL）/ `playable` / `custom` 原样返回；
- `parseCustomMetadata(custom)`：`custom` 公开白名单（spec.md §8.4）的防御性解析，**收敛 apps/player `parseCustom` 语义**：
  - `category` 需 `id` 与 `path` 均为非空字符串，否则丢弃；`description` trim 后非空才保留；`tags` 丢弃空项、按首现去重；
  - 输入为 `null` / 非对象 / 脏结构 → 返回 `{}`，**解析失败不阻断播放**（容错口径同 §8.4）；
- `poster_url` 为存储签名直出（`s3_presign` 下有效期 = `ManifestTTL`，默认 4h）——SDK 不缓存推断；长列表页图片过期后需重新拉取（文档提示）。

---

## 8. 错误模型

```ts
export class DeliveryError extends Error {
  /** 服务端错误码（api.md §0.2 全表）；网络 / 超时 / 非 JSON 响应统一 "internal" */
  readonly code: ErrorCode;
  /** HTTP 状态码；网络层失败 = 0 */
  readonly status: number;
  /** SDK 附加排查建议（不覆盖服务端 message） */
  readonly hint?: string;
}

export class PlayerSdkError extends Error {
  readonly code: "sdk_invalid_config" | "sdk_no_credential" | "sdk_disposed" | "sdk_bad_response";
}
```

- `DeliveryError.code` 的类型来自契约 `ErrorCode`（type-only 引用，防漂移）；SDK 提供 `describeError(code)` 辅助文案表，单测断言**覆盖全部错误码**；
- HTTP 非 2xx 但响应非 JSON 错误信封 / 缺 `error` 字段 → `DeliveryError("internal", status)`（`sdk_bad_response` 仅用于结构无法解析的 SDK 关键响应）；
- 宿主处置对照（与 api.md §2 错误码表同源）：

| code | SDK 已做 | 宿主应做 |
|---|---|---|
| `invalid_credentials` | 透传（不清凭据） | 提示账号 / 口令；更新 `setCredential` 后重试 |
| `unauthorized` | 自动重登一次 | 二次仍失败 → 登录态失效提示（`static` 模式需重新注入 token） |
| `bad_token` | SDK 资源请求自动重签一次 | 播放器内 403 → `handle.refresh()` 换源 |
| `not_found` | 透传 | 媒资 / 轨道已删，回列表 |
| `not_playable` | 透传 | 媒资未就绪 / 指定模板无产物（消息含可选值），回列表或换模板 |
| `session_limit` | 透传 + hint | 等待会话过期 / 调大并发上限（`force_new` 不绕过，§4.5） |
| `internal`（5xx / 网络） | 透传；GET 可按 `retries` 重试 | 展示错误 + 重试入口 |

---

## 9. 事件模型（最小集）

```ts
export type PlayerSdkEvent =
  | { type: "auth:changed"; reason: "login" | "refresh" | "switched" | "expired" }
  | { type: "playback:refreshed"; media_id: string; manifest_url: string; expires_at: string;
      reason: "auto" | "manual" | "retry" }
  | { type: "playback:template_changed"; media_id: string; template_id: string; manifest_url: string }
  | { type: "error";
      operation: "login" | "list_media" | "get_media" | "play" | "refresh"
               | "switch_template" | "subtitle" | "auto_refresh";
      error: DeliveryError | PlayerSdkError };
```

- 订阅：`sdk.on(type, listener)` 或 `sdk.on(listener)`（全量）；返回取消函数；构造配置 `onEvent` 等价全量订阅；
- 监听器异常被 SDK 捕获隔离（try/catch），不得影响内部流程；监听器同步调用，SDK 不等待异步返回值；
- **明确不做**：诊断探测（卡顿 / CORS 根因 / 首帧统计）——消费方自建（apps/player 保留）。

---

## 10. 与服务端契约的对齐

- 类型对齐：SDK 公共 DTO 均 type-only 引用 `packages/contracts`（唯一真相源）；`task contracts` 重生成后 SDK 类型自动跟随，`bun test` 覆盖；
- 兼容承诺（v1）：
  - 服务端**新增响应字段 / 新增端点** → SDK 忽略未知字段，不破坏；
  - 服务端**删除或改语义** → 属契约变更，需 SDK 同版本跟进（分发形态见 §13 Q2）；
  - SDK 只调用 `api.md` §2 已实现端点，不调用契约中未实现项（如 cursor 分页）；
- SDK 必须原样透出的服务端语义清单（不得二次加工）：`limit` 回退、模板自动选择、会话复用 / 幂等、`expires_at`、错误码与文案、`custom` 白名单内容（仅做防御解析）。

---

## 11. 安全与 P0 纪律

- SDK 接触面清单（白名单）：`/v1/auth/login`、`/v1/media`、`/v1/media/{id}`、`/v1/media/{id}/play`、字幕 VTT（仅文本辅助）；**永不请求** `/v1/media/{id}/key`、`/manifest/*`（拉清单）、分片 URL——这些属播放器内核与宿主；
- 明文材料：口令仅存在于内存与 login 请求体（若注入 storage 也只存 JWT）；日志默认**不打印** `Authorization`、token、签名 URL 的 query；
- 签名 URL 原样透出（N2）：SDK 不拼接、不裁剪、不缓存于 storage；
- 存储注入的安全选择属宿主责任：README 明确「不推荐 localStorage；浏览器建议内存 / sessionStorage；移动端建议安全存储」；
- CORS 前置（宿主 / 部署侧）：浏览器直连需 `DELIVERY_CORS_ORIGINS` 放行 SDK 宿主源站；分片直连对象存储需**对象桶 CORS** 放行（spec.md §11.2）——未配置表现为「有总时长一直转圈」，README 给排查清单。

---

## 12. 测试与验收

> **实现落点（2026-10-16）**：S1 源码在 `packages/player-sdk/src/{index,config,client,auth,media,playback,subtitles,events,errors}.ts`；
> §12.1 单测矩阵 T1~T18 落在 `packages/player-sdk/test/{auth,playback,media-errors}.test.ts`（`bun test packages/player-sdk`，30 项全绿）；
> S2 消费方改造见 `apps/player/src/lib/sdk.ts`（tokenProvider）+ `components/PlayView.tsx` / `app/page.tsx`，`lib/delivery.ts` 已删除；
> S4 交付物 README 见 `packages/player-sdk/README.md`。**S3（体验环境端到端）待维护者按 §12.2 执行。**

### 12.1 单测矩阵（注入 fetch stub + 假时钟）

| # | 场景 | 断言 |
|---|---|---|
| T1 | 口令模式 login 成功 | 请求体 / 头正确；`getAccessToken` 二次调用零请求 |
| T2 | login `invalid_credentials` | `DeliveryError{code, status:401, message}` 保真；配置未被清空 |
| T3 | 401 兜底 | 业务请求 401 → 重登 1 次 → 重试成功；二次 401 抛出 + `auth:changed{expired}` |
| T4 | JWT 提前重登 | 假时钟进入 leeway 窗口 → 触发重登；`auth:changed{refresh}` |
| T5 | 并发去重 | 10 并发 `listMedia` 只发生 1 次 login |
| T6 | `play` 缓存命中 | 同媒资二次 `play` 零请求；`templateId` 相同零请求 |
| T7 | 会话复用 | `play` 请求体无 `force_new`；`forceNew:true` 时携带 |
| T8 | 自动续签 | 假时钟到点触发重签；事件序列 `playback:refreshed{auto}` → 重新排程；失败重试一次后 `error{auto_refresh}` |
| T9 | `autoRefresh:false` | 不排程、无事件 |
| T10 | 403 兜底 | 字幕拉取 403 → refresh → 新 URL 重试一次成功 |
| T11 | 清晰度切换 | 携带 `template_id`；handle 更新与事件；失败不改变 handle |
| T12 | `session_limit` / `not_playable` | 错误映射与 hint；`force_new` 语境文案正确 |
| T13 | `setCredential` 切换 | 清 token / 会话；旧句柄 `disposed`；事件 `auth:changed{switched}` |
| T14 | `attachPlayback` | 零请求；无凭据时 refresh / switchTemplate 抛 `sdk_no_credential` |
| T15 | `parseCustomMetadata` | 脏数据容错（缺 id / 空 description / 重复 tags / 非对象） |
| T16 | 错误码覆盖 | `describeError` 覆盖契约 `ErrorCode` 全表（与 `@openvod/shared ERROR_CODES` 逐字一致，dev 依赖断言） |
| T17 | 超时 / 网络失败 | `DeliveryError{code:"internal", status:0}`；GET 按 `retries` 重试 |
| T18 | storage 注入 | 写 / 读 / 清除；切换身份清旧值；脏数据丢弃并重登 |

### 12.2 集成验收（体验环境，S3）

1. 体验环境四端起全（trial-env.md），SDK 以口令模式接入：`play` 产出的 `manifest_url` 交给 `ffprobe` / `ffmpeg` 直播 → 加密媒资解出内容（验证签名链路完好，且独立于 SDK 客户端）；
2. 伪造过期 JWT（改 `expires_at` / 换假 token）→ 业务请求自动重登恢复；
3. 伪造过期清单 token（手工改 URL `t`）→ SDK 字幕拉取自动重签恢复；播放器侧按交付物 README 的「播放器内 403 处置」片段 `refresh()` 恢复；
4. `setCredential` 切换两个账号 → 会话 / 事件正确；
5. 自动续签：将 `refreshLeewaySec` 调大（或管理端临时调小 `playback_manifest_ttl_sec`）→ 观察重签事件与换源。

### 12.3 `apps/player` 改造验收（S2，SDK 首个消费者）

- 以 tokenProvider 接入——`getToken` 调 Next 路由 `/api/session` 并把响应映射为 `{ access_token, expires_at }`（**不把账号口令下发浏览器**），保留 spec.md §11.3 的既有安全边界，同时实战校验 tokenProvider 模式；
- 列表 / 播放页 / 清晰度切换（进度保留逻辑留在页面）/ 字幕选轨 / 错误态行为回归；删除页面内重复的 `lib/delivery.ts` 接入逻辑（保留 React 状态层）；
- 回归清单：spec.md §11.7 手工验收 1~6 项全部通过。

### 12.4 交付物

- `packages/player-sdk` 源码 + §12.1 单测；
- `packages/player-sdk/README.md`：快速开始（四种鉴权模式各一段）、生命周期时序（登录 → play → 自动重签 → dispose）、换源保留进度片段、播放器内 403 处置片段、CORS / 黑屏排查清单；
- `apps/player` 改造；文档索引同步：`README.md` 阅读顺序（第 10/11 项）与 `intent.md`「播放器 SDK」章节已在本次设计中登记。

---

## 13. 演进项与开放问题

| # | 项 | 说明 |
|---|---|---|
| Q1 | **服务端会话释放端点** | v1 无（`dispose` 仅本地）。新增 `DELETE /v1/media/{id}/sessions/{sid}` 可让 SDK 立即归还并发额度；需走 ADR / 契约流程 |
| Q2 | **npm 公开发布形态** | v1 为 workspace 包（`private: true`）。公开发布需：dist 构建 + 类型内联（或 `@openvod/contracts` 一并发布）+ 独立 semver——与仓库「版本号唯一真源 = 根 package.json」规则的协调方案待定 |
| Q3 | **token refresh 端点** | 可让 `password` 模式退化为 refresh token（凭据不常驻内存），与 ADR-0007 演进联动 |
| Q4 | 播放器适配器 | hls.js / Video.js / ExoPlayer / AVPlayer 适配子包（自动换源、进度保留、字幕挂载）——v1 明确非目标，本文档 §4.3 / §5.2 已预留事件与语义 |
| Q5 | 播放进度持久化 / 上报 | 本地续播与服务端进度端点（需新数据面）；本轮未选入 v1 |
| Q6 | 多端移植（Android / iOS / RN / 小程序） | 以本文档协议层行为（§3~§8）为蓝本；**注意 RN 可用同一 TS 包**（注入 fetch 即可） |
| Q7 | 是否为 SDK 建 ADR（架构与分发策略） | SDK 引入「官方客户端」新交付面，实现评审时决定是否需要 ADR-0020 固化 |

---

## 附录 A：SDK 调用 → 分发端端点映射

| SDK 调用 | 端点 | 鉴权 |
|---|---|---|
| `auth.getAccessToken()` | `POST /v1/auth/login` | 凭据 |
| `listMedia()` | `GET /v1/media?limit=` | JWT |
| `getMedia(id)` | `GET /v1/media/{id}` | JWT |
| `play()` / `refresh()` / `switchTemplate()` | `POST /v1/media/{id}/play` | JWT |
| `fetchSubtitleText(track)` | `GET /v1/media/{id}/subtitles/{trackId}.vtt?t=` | URL token（typ=v） |
| （SDK 不发起）主 / 子清单 | `GET /v1/media/{id}/manifest/*?t=&tpl=` | URL token（typ=m）——播放器内核发起 |
| （SDK 不发起）密钥 | `GET /v1/media/{id}/key?t=` | URL token（typ=k）——播放器内核发起 |
| （SDK 不发起）分片 | 存储签名直出 URL | 存储签名 / CDN（ADR-0019） |
| `attachPlayback()` | — | 零请求 |

## 附录 B：故障 → 处置（SDK 与宿主责任边界）

| 现象 | 根因 | SDK 行为 | 宿主 / 部署侧 |
|---|---|---|---|
| 黑屏、一直转圈（有总时长） | 对象桶 CORS 未放行播放端源站 | 不可见 | 对象桶 CORS 放行（spec.md §11.2） |
| 业务请求 401 | JWT 过期 / 被吊销（封禁 / 重置口令） | 自动重登一次 | 二次失败提示登录态 |
| 中途画面停住 / 后段 403 | 清单 token 或分片预签名过期 | 自动续签事件（若未 dispose） | 监听 `playback:refreshed` 换源；播放器错误时 `refresh()` |
| 播放中最后一段失败（超长视频） | 分片预签名 TTL = ManifestTTL | 重签可解（新清单带新预签名） | 换源（HLS 需重建，见 README 片段） |
| 首播 409 `session_limit` | 跨媒资会话累积达上限 | 透传 + hint | 调大并发上限 / 等待过期（`force_new` 无效） |
| 切换清晰度 409 `not_playable` | 指定模板产物已被删除 / 不完整 | 不打断当前播放 | 刷新 `templates[]` 后重选 |
| token 模式 401 后仍失败 | `static` 无重登能力 | 抛错 + `auth:changed{expired}` | 重新注入 token 或改配置为 tokenProvider |
