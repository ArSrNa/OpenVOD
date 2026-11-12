# openvod-jssdk

OpenVOD 播放器接入 SDK（v1）：把「登录 → 媒资 → 播放会话 → 签名 URL → 续签 → 换清晰度」的接入逻辑收敛为唯一公共 API，
宿主只负责播放器元素与 UI。**零运行时依赖**（仅 `fetch`，可注入），浏览器 / Node 18+ / React Native 同一份实现。

权威设计：`docs/vod/player-sdk-intent.md`（定位与范围）、`docs/vod/player-sdk-spec.md`（接口与语义）。
接口参考：`docs/vod/api.md §2`（分发端 HTTP API）。首个消费方：`apps/player`。

## 安装

```bash
# npm 官方
npm i openvod-jssdk

# CNB 制品库（组织级 npm 制品库；地址在「制品库 → 设置 → 基础设置」查看）
npm i openvod-jssdk --registry=https://npm.cnb.cool/<组织>/<制品库>/-/packages/
# 长期使用建议写进项目 .npmrc：
# registry=https://npm.cnb.cool/<组织>/<制品库>/-/packages/
# always-auth=true
# //npm.cnb.cool/<组织>/<制品库>/-/packages/:_authToken=${CNB_TOKEN}
```

发布产物为 **ESM + CJS + 打包后的 `.d.ts`**，零运行时依赖（连 `@openvod/*` 私有包也不需要——公共 DTO 类型
在 `src/types.ts` 是自包含镜像，一致性由 `bun run typecheck` 的编译期断言守住）。

## 设计边界（不变量）

| 编号 | 不变量 |
|---|---|
| N1 | SDK **永不接触视频字节与密钥材料**：不请求 `/key`、不下载分片、不持有 CEK（解密在播放器 / 浏览器本地完成） |
| N2 | 全部签名 URL **一律来自 `play` 响应原样透出**，SDK 不生成 / 不校验 / 不拼接 |
| N3 | 业务语义以服务端为准：`limit` 回退、模板自动选择、会话复用、`expires_at` 判定都不在客户端复制 |
| N4 | **错误保真**：服务端错误码 / 文案 / HTTP 状态原样透出，SDK 只附加 `hint` 排查建议 |
| N5 | 重登一律经配置的凭据源重新 `login`（v1 无 refresh token） |

## 快速开始

```ts
import { createPlayerSdk } from "openvod-jssdk";

// ① 口令模式（SDK 负责 login / JWT 缓存 / 到期重登）
const sdk = createPlayerSdk({
  baseUrl: "https://vod.example.com", // delivery 基址（http/https，自动去尾斜杠）
  credential: { mode: "password", username: "viewer", password: "******" },
});

// ② tokenProvider 模式（宿主自治登录，推荐 Web 宿主经自己的后端换 JWT，口令不下发浏览器）
const sdk2 = createPlayerSdk({
  baseUrl: "https://vod.example.com",
  credential: {
    mode: "tokenProvider",
    getToken: async () => {
      const res = await fetch("/api/session");           // 宿主的后端路由
      const body = await res.json();
      return { access_token: body.access_token, expires_at: body.expires_at };
    },
  },
});

// ③ static 模式（宿主已有 JWT 且自行负责续期）：无重登能力，过期即抛错 + auth:changed{expired}
const sdk3 = createPlayerSdk({
  baseUrl: "https://vod.example.com",
  credential: { mode: "static", token: jwtFromHost, expires_at: "2026-10-17T08:00:00Z" }, // expires_at 可省（缺省缓存至 401）
});

// ④ attach 模式（不配置 credential）：仅接管已有签名 URL，零请求
const sdk4 = createPlayerSdk({ baseUrl: "https://vod.example.com" });
const attached = sdk4.attachPlayback({ media_id: "55395830", manifest_url: signedUrlFromServer });
```

### 生命周期时序

```
宿主                           SDK                                    delivery
 │ createPlayerSdk(config) ──▶ 同步构造（零网络请求）
 │ sdk.listMedia() ─────────▶ getAccessToken ── login（或 getToken） ──▶ POST /v1/auth/login
 │                        ◀── JWT 缓存（leeway 内零请求；401 → 重登一次并重试）
 │ sdk.play(id) ────────────▶ 会话缓存命中？ ── 命中 → 零请求返回 handle
 │                        │                          未命中/将过期 → POST /v1/media/{id}/play
 │                        ◀── handle{ sid, manifest_url, expires_at, template_id, templates, subtitles }
 │ video.src = manifest_url ─▶ （播放器自行取 /key 与分片；SDK 不介入）
 │                        ├─ 到期前 refreshLeewaySec：自动 play 重签 ─▶ emit playback:refreshed{auto}
 │ sdk.on("playback:refreshed") ─ 宿主换源（保留进度，见下）
 │ handle.switchTemplate(id) ▶ POST play(template_id) → 原位更新 ─▶ emit playback:template_changed
 │ handle.dispose() / sdk.dispose() ▶ 停定时器 + 本地失效（服务端会话按 TTL 过期）
```

### 从列表到播放（完整生命周期）

```ts
const page = await sdk.listMedia({ limit: 50 });     // 仅 READY 媒资；next_cursor v1 恒 null
const detail = await sdk.getMedia("55395830");       // probe / poster / custom（公开白名单）
const custom = parseCustomMetadata(detail.custom);   // { category?, description?, tags? }（脏数据容错）

const handle = await sdk.play("55395830");           // 建 / 复用播放会话，签发签名主清单 URL
video.src = handle.manifest_url;                     // 清单 → 密钥 → 分片全链路已带签名

// 清晰度：handle.templates 是「该媒资实际存在的模板产物」，不是全部模板
const options = handle.templates.map((t) => ({ label: templateLabel(t), value: t.id }));
await handle.switchTemplate("ctemplate00000000000002"); // 复用会话换源；返回值仍是同一 handle
video.src = handle.manifest_url;                        // 换源后读最新字段（见下方「可变视图」）

// 字幕：URL 是 typ=v 签名地址；403 时 SDK 自动重签一次
const tracks = handle.subtitles;
const vtt = await handle.fetchSubtitleText(tracks[0]);

// 播放中 token 到期：SDK 自动重签并通知宿主换源
const off = sdk.on("playback:refreshed", (event) => {
  video.src = event.manifest_url;                   // 事件 payload 与字段逐字一致
});

handle.dispose();                                    // 停自动续签 + 本地失效（不释放服务端会话）
```

### 变更订阅与生命周期

```ts
const off = sdk.on((event) => console.log(event.type, event)); // 全量订阅
sdk.on("playback:template_changed", (e) => {/* 切清晰度成功 */});
sdk.on("error", (e) => {/* e.operation：login / list_media / get_media / play / refresh / switch_template / subtitle / auto_refresh */});
sdk.dispose();        // 清全部定时器与缓存（服务端会话按 TTL 自然过期）
```

## API 速览（完整签名见 spec §2.3）

| 调用 | 说明 |
|---|---|
| `sdk.auth.getAccessToken({ force? })` | 取有效 JWT（缓存命中零请求；到期前按 leeway 重登；401 兜底强制重登） |
| `sdk.auth.setCredential(source \| null)` | 运行时切换身份：清 token / 会话缓存 / 定时器，旧句柄全部 `disposed` |
| `sdk.listMedia({ limit?, signal? })` | 媒资列表（`limit` 原样传给服务端，由服务端裁决） |
| `sdk.getMedia(id, { signal? })` | 媒资详情（非 READY 也返回，`playable=false`） |
| `sdk.play(id, { templateId?, forceNew?, signal? })` | 建 / 复用会话；**本地缓存新鲜时零请求**；并发同语义调用 single-flight |
| `sdk.attachPlayback(descriptor)` | 接管已有签名 URL（零请求；无凭据时 `refresh` / `switchTemplate` 抛 `sdk_no_credential`） |
| `sdk.fetchSubtitleText(track)` | 拉 VTT 文本（自动定位所属句柄以支持 403 重签重试） |
| `handle.switchTemplate(id)` | 复用会话换源（`id === 当前 template_id` 时空操作；失败不打断当前播放） |
| `handle.refresh({ force? })` | 重新签发；`force: true` 强制请求（用于「重新播放」） |
| `handle.fetchSubtitleText(track)` | 句柄内字幕文本（403 → 重签 → 新 URL 重试一次） |
| `handle.dispose()` | 停定时器 + 句柄失效（服务端无释放端点） |
| `sdk.dispose()` | 清全部定时器与缓存；销毁后所有入口抛 `sdk_disposed` |

### 配置项（`PlayerSdkConfig`）

| 字段 | 默认 | 说明 |
|---|---|---|
| `baseUrl` | 必填 | delivery 基址，仅 http/https；非法抛 `sdk_invalid_config` |
| `credential` | 无 | 见上文三种模式 + attach |
| `fetch` | 全局 `fetch` | 注入自定义实现（RN / 测试 / 代理） |
| `timeoutMs` | `10000` | 单请求超时 |
| `retries` | `0` | **幂等 GET** 的网络层重试次数（5xx / 网络失败；POST 不重试） |
| `jwtRefreshLeewaySec` | `300` | JWT 到期前多久重登 |
| `refreshLeewaySec` | `300` | 会话 / 清单 token 到期前多久自动重签 |
| `autoRefresh` | `true` | 关掉后只提供手动 `refresh()` |
| `storage` | 无（纯内存） | 注入 JWT 持久化（仅存 `{ access_token, expires_at, identity }`，**不存口令 / 播放 URL**）。安全建议：**不推荐 `localStorage`**；浏览器用内存或 `sessionStorage`，移动端用 Keychain / Keystore 等安全存储 |
| `onEvent` | 无 | 全局事件监听（等价 `sdk.on(listener)`） |

## 错误处理

```ts
import { DeliveryError, PlayerSdkError, describeError } from "openvod-jssdk";

try {
  await sdk.play(mediaId);
} catch (e) {
  if (e instanceof DeliveryError) {
    e.code;    // api.md §0.2 错误码（类型来自契约 ErrorCode）
    e.status;  // HTTP 状态；0 = 网络 / 超时 / 取消
    e.message; // 服务端文案原样（N4）
    e.hint;    // SDK 排查建议（describeError(code)）
  } else if (e instanceof PlayerSdkError) {
    e.code;    // sdk_invalid_config | sdk_no_credential | sdk_disposed | sdk_bad_response
  }
}
```

高频错误：

| 场景 | 表现 | 处理 |
|---|---|---|
| 分发端未启动 / CORS 未放行 | `DeliveryError{code:"internal", status:0}` | 检查 `DELIVERY_CORS_ORIGINS` 是否放行宿主源站 |
| 账号被禁 / 口令已变 | `unauthorized`（重登一次后仍 401）+ `auth:changed{expired}` | 引导重新登录或 `setCredential()` |
| 播放器内清单 / 密钥 / 分片 403 | 播放中断（SDK 无法感知播放器内部请求） | 调 `handle.refresh({ force: true })` 换源 |
| 并发会话达上限 | `session_limit`（**`forceNew` 不绕过上限**） | 等旧会话过期或管理端调大 `max_concurrent_sessions` |
| 媒资未就绪 / 模板无产物 | `not_playable` | 回列表或从 `handle.templates` 重选 |

## 两段必备的宿主代码

### 换源保留进度（自动续签 / 切清晰度通用）

`switchTemplate` / `refresh` 会换掉 `manifest_url`（新 token），播放器换源后应恢复进度：

```ts
let resume: { time: number; wasPlaying: boolean } | null = null;

sdk.on("playback:refreshed", (event) => {
  resume = { time: video.currentTime, wasPlaying: !video.paused };
  video.src = event.manifest_url;                  // 换源（hls.js 需 destroy + attachMedia 重建）
});

video.addEventListener("loadedmetadata", () => {
  if (!resume) return;
  video.currentTime = resume.time;                 // 恢复失败请静默从头，不要抛给用户
  if (resume.wasPlaying) void video.play().catch(() => {});
  resume = null;
});
```

### 播放器内 403 处置（清单 / 密钥 / 分片）

浏览器原生 HLS 与 hls.js 的分片 / 密钥请求 SDK 无法感知（SDK 不接触视频字节，N1）。播放器报错或长时间
黑屏时，用它换一套新 token 再重载：

```ts
async function recoverPlayback(errorCode?: number) {
  if (errorCode !== 403) return;                   // 只在 403 bad_token 场景重签
  await handle.refresh({ force: true });           // 复用会话重签（不新建会话、不消耗并发额度）
  video.src = handle.manifest_url;                 // 再换源；必要时 resume 进度
}
```

## 排错清单

| 现象 | 排查顺序 |
|---|---|
| 列表页报 `internal / status 0` | ① 分发端是否启动：`curl <baseUrl>/healthz`；② 宿主源站是否在 `DELIVERY_CORS_ORIGINS`（宿主自建同源代理时可免，如 `apps/player` 的 `/api/delivery`）；③ `baseUrl` 从浏览器是否可达 |
| 列表能出、点进播放黑屏 | ① token 是否过期（`handle.expires_at`）；② 桶（COS / RustFS）是否放行宿主源站 CORS（分片直连对象存储）；③ 产物是否完整（管理端产物列表） |
| 播到一半 403 / 后段失败 | token 与分片预签名过期：调大 `refreshLeewaySec` 观察自动重签，或按上文「播放器内 403 处置」手动重签 |
| `session_limit`（409） | 同账号并发会话达上限（`forceNew` **不绕过**）：等 TTL 过期或管理端调大 `max_concurrent_sessions` |
| `not_playable`（409） | 媒资未就绪或所选模板无产物：回列表，或从 `handle.templates` 重选 |
| `auth:changed{expired}` | 账号被禁 / 口令已变：`setCredential()` 换凭据，或引导重新登录 |
| React 视图不更新 | `handle` 是可变视图：`switchTemplate` / `refresh` 后需重读字段重建快照（见「换源保留进度」） |

## 已知约束与宿主职责

- **`PlaybackHandle` 是可变视图**：`switchTemplate` / `refresh` 原位更新并返回**同一实例**。React 用快照驱动渲染
  （参考 `apps/player/src/components/PlayView.tsx` 的 `snapshot(handle)`），不要靠引用比较触发重渲染。
- **换源是宿主职责**：SDK 只发事件（`playback:refreshed` / `playback:template_changed`），把新 `manifest_url`
  赋给播放器元素由宿主完成；换源后的进度保留同样由宿主实现。
- **字幕挂载与渲染**：SDK 只给轨道数据与 VTT 文本，不做解析 / 样式 / 重排。
- **自动续签失败**：先等 30s 重试一次，仍失败发 `error{operation:"auto_refresh"}` 并停止（防故障放大）。
- **多标签 / 多账号**：`storage` 默认不启用（纯内存，关标签即失效）；启用时仅按 `identity` 校验，切换身份自动清除。
- 客户端不复制服务端策略：`limit` 非法回退、模板自动选择、会话并发上限一律由服务端裁决。

## 开发

```bash
bun test packages/player-sdk                  # 单测矩阵（注入 fetch + 假时钟，无真实网络）
bun run --cwd packages/player-sdk test:coverage   # 同上 + 覆盖率（text + coverage/lcov.info）
bun run --cwd packages/player-sdk typecheck       # tsc（含契约镜像的编译期一致性断言）
bun run --cwd packages/player-sdk build           # tsup → dist/{index.js,index.cjs,index.d.ts}
```

- 源码：`src/{index,config,client,auth,media,playback,subtitles,events,errors,types}.ts`
- `src/types.ts` 是公共 DTO 的**自包含镜像**（发布包零依赖，声明文件不得出现私有包 import）；
  与 `packages/contracts` 的一致性由 `test/contract-parity.ts`（编译期，随 `typecheck`）+ `test/errors.test.ts`
  （运行时逐字比对 ERROR_CODES）守住。
- 新增能力必须同步：`docs/vod/player-sdk-spec.md`（接口语义）→ 单测（T 编号）→ 本 README。

## 发布（npm 官方 + CNB 制品库）

```bash
bun run --cwd packages/player-sdk publish:dry    # 演练：构建 + 打包清单（不联网、无需令牌）
bun run --cwd packages/player-sdk publish:npm    # 只发 npm 官方
bun run --cwd packages/player-sdk publish:cnb    # 只发 CNB 制品库
bun run --cwd packages/player-sdk publish:both   # 两个都发（= 发版流水线用的命令）
```

- **版本号唯一真源是根 `package.json` 的 `version`**（本包刻意不声明 `version`，仓库守卫见
  `apps/admin/test/version-source.test.ts`）；脚本读它并注入发布清单，`--version` 可显式覆盖（补发历史版本）。
- 发布清单在 `.run/sdk-publish/` 暂存生成：`exports` 指向 `dist/`（仓库内仍指向 `src/`，供 workspace 直引）；
  脚本还会断言产物自包含（4 个产物文件不得 import 私有包）。
- 令牌只经环境变量传入、临时 `.npmrc` 权限 600 且用后即删：`NPM_TOKEN`（npm 官方）、
  `CNB_NPM_TOKEN`（CNB，流水线内缺省回退内置 `CNB_TOKEN`）、`CNB_NPM_REGISTRY`（制品库地址）。
- **CI**：`.cnb.yml` 的 `.publish-sdk` 任务在 **`tag_push`** 时自动执行（也可用仓库页「发布播放器SDK」按钮手动触发）：
  单测覆盖率 → `testing:coverage` 上报 CNB 洞察/徽章（红线 95%）→ 发布到两个制品库；
  `NPM_TOKEN` 经密钥仓库 `arsrna/env` 的 `npm.yml` 注入。tag 名与根版本不一致时脚本会拒绝发布。
