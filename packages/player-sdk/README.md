# openvod-jssdk

OpenVOD 播放器接入 SDK。它帮你把「登录 → 拿媒资列表 → 发起播放 → 拿到播放地址 → 播放中自动续期」这些事都做好，
你只需要负责把播放地址交给 `<video>` 播放，以及处理界面上的事。

可以在浏览器、Node 18+、React Native 里使用，没有任何依赖。

## 安装

```bash
npm i openvod-jssdk
```

如果用 CNB 制品库：

```bash
npm i openvod-jssdk --registry=https://npm.cnb.cool/arsrna/media/openvod/-/packages/
```

长期使用建议写进项目的 `.npmrc`：

```
registry=https://npm.cnb.cool/arsrna/media/openvod/-/packages/
always-auth=true
//npm.cnb.cool/arsrna/media/openvod/-/packages/:_authToken=${CNB_TOKEN}
```

## 快速开始

SDK 创建时要告诉它两件事：服务地址（`baseUrl`），以及用什么方式登录。登录方式有四种，按你的场景选一种：

### 方式一：用户名密码（最简单）

SDK 自己负责登录和续登，适合快速跑通：

```ts
import { createPlayerSdk } from "openvod-jssdk";

const sdk = createPlayerSdk({
  baseUrl: "https://vod.example.com",
  credential: { mode: "password", username: "viewer", password: "******" },
});
```

### 方式二：由你的后端提供 token（网页端推荐）

不要把用户密码放进浏览器。让用户先登录你的网站，你的后端把 token 发给前端，SDK 每次需要时找你要：

```ts
const sdk = createPlayerSdk({
  baseUrl: "https://vod.example.com",
  credential: {
    mode: "tokenProvider",
    getToken: async () => {
      const res = await fetch("/api/session"); // 你自己的后端接口
      const body = await res.json();
      return { access_token: body.access_token, expires_at: body.expires_at };
    },
  },
});
```

### 方式三：直接给一个现成的 token

你自己负责 token 的更新。token 过期后 SDK 不会重新登录，只能报错：

```ts
const sdk = createPlayerSdk({
  baseUrl: "https://vod.example.com",
  credential: { mode: "static", token: jwtFromHost, expires_at: "2026-10-17T08:00:00Z" },
});
```

### 方式四：不登录，只播放一个现成的地址

如果你已经从别处拿到了签名好的播放地址，SDK 可以直接接管它，不会发任何请求：

```ts
const sdk = createPlayerSdk({ baseUrl: "https://vod.example.com" });
const handle = sdk.attachPlayback({ media_id: "55395830", manifest_url: signedUrlFromServer });
```

## 从列表到播放

```ts
// 拿媒资列表（只会返回已经转码完成、可以播放的媒资）
const page = await sdk.listMedia({ limit: 50 });

// 拿单个媒资详情（封面、描述、标签等）
const detail = await sdk.getMedia("55395830");

// 发起播放，拿到播放句柄
const handle = await sdk.play("55395830");

// 把地址交给播放器，之后清单、分片、解密密钥的请求都会自动带上签名
video.src = handle.manifest_url;
```

### 切换清晰度

```ts
// handle.templates 是这个媒资实际有的清晰度选项
const options = handle.templates.map((t) => ({ label: t.name, value: t.id }));

// 切换后播放地址会变，需要重新赋给播放器（见下文「换源时保留播放进度」）
await handle.switchTemplate("ctemplate00000000000002");
video.src = handle.manifest_url;
```

### 字幕

```ts
const tracks = handle.subtitles;               // 可用的字幕轨道
const vtt = await handle.fetchSubtitleText(tracks[0]); // 拿到字幕文本
```

## 播放中你需要处理的两件事

### 1. token 快过期时，SDK 会自动换新地址，你要负责换源

播放地址里的签名是有有效期的。快到期时 SDK 会自动请求一个新地址，并发出 `playback:refreshed` 事件。
**新地址不会自动生效**，你需要监听事件、换源，并恢复播放进度：

```ts
let resume: { time: number; wasPlaying: boolean } | null = null;

sdk.on("playback:refreshed", (event) => {
  // 先记下当前的播放进度和播放状态
  resume = { time: video.currentTime, wasPlaying: !video.paused };
  // 换成新地址（如果用 hls.js，需要销毁重建实例）
  video.src = event.manifest_url;
});

video.addEventListener("loadedmetadata", () => {
  if (!resume) return;
  video.currentTime = resume.time;              // 恢复进度，失败就从头播，别报错打断用户
  if (resume.wasPlaying) void video.play().catch(() => {});
  resume = null;
});
```

切换清晰度时也一样：`switchTemplate` 会换地址并触发 `playback:template_changed` 事件，同样需要换源和恢复进度。

### 2. 播放器里出现 403 时，手动换一套新签名

播放器内部请求分片、密钥时报 403（常见于播放暂停太久、签名已过期），SDK 感知不到这些请求，
需要你手动重签一次再换源：

```ts
async function recoverPlayback(errorCode?: number) {
  if (errorCode !== 403) return;
  await handle.refresh({ force: true });  // 复用当前会话重签，不会新开会话
  video.src = handle.manifest_url;
}
```

## 配置项

```ts
const sdk = createPlayerSdk({
  baseUrl: "https://vod.example.com",  // 必填，服务地址
  credential: { /* 见「快速开始」四种方式 */ },
  fetch: myFetch,          // 可选：自定义请求实现（React Native、测试、代理场景）
  timeoutMs: 10000,        // 单个请求的超时时间
  retries: 0,              // 列表、详情这类查询请求失败时自动重试几次（只重试查询，不重试播放）
  jwtRefreshLeewaySec: 300,   // 登录凭证到期前多久自动重新登录
  refreshLeewaySec: 300,      // 播放地址到期前多久自动换新
  autoRefresh: true,       // 设为 false 则不自动换新，只能手动调 handle.refresh()
  storage: myStorage,      // 可选：把登录凭证存起来（默认只存在内存里，关页面就没了）
  onEvent: (e) => {},      // 可选：监听所有事件，等价于 sdk.on(listener)
});
```

关于 `storage` 的安全提醒：**不建议用 `localStorage` 存登录凭证**。
浏览器里用内存或 `sessionStorage`，App 里用系统安全存储（iOS Keychain / Android Keystore）。

## 事件

```ts
// 监听单个事件，返回的函数用来取消监听
const off = sdk.on("playback:refreshed", (e) => {});
off();

// 或者监听全部事件
const offAll = sdk.on((event) => console.log(event.type, event));
offAll();
```

| 事件 | 什么时候发生 |
|---|---|
| `playback:refreshed` | 播放地址快过期，SDK 自动换了新地址（你需要换源） |
| `playback:template_changed` | 切换清晰度成功（你需要换源） |
| `auth:changed` | 登录状态变了，比如凭证过期、账号被禁 |
| `error` | 出错了，`e.operation` 会告诉你是哪一步出的问题 |

## 错误处理

```ts
import { DeliveryError, PlayerSdkError } from "openvod-jssdk";

try {
  await sdk.play(mediaId);
} catch (e) {
  if (e instanceof DeliveryError) {
    e.code;    // 服务端返回的错误码，如 "session_limit"
    e.status;  // HTTP 状态码；0 表示网络不通、超时或请求被取消
    e.message; // 服务端返回的原始错误说明
    e.hint;    // SDK 附带的排查建议
  } else if (e instanceof PlayerSdkError) {
    e.code;    // SDK 自己的问题，如配置不对、没配登录方式、SDK 已销毁
  }
}
```

常见错误：

| 错误 | 意思 | 怎么办 |
|---|---|---|
| `internal` + status 0 | 连不上服务，或服务没开 CORS | 见下方「常见问题」 |
| `unauthorized` | 账号被禁或密码改了 | 引导用户重新登录 |
| `session_limit` | 这个账号同时播放的设备数到上限了 | 等旧会话过期，或在管理台调大上限 |
| `not_playable` | 媒资还没转码完，或所选清晰度没有产物 | 回列表刷新，或换个清晰度 |
| 播放器里 403 | 播放地址里的签名过期了 | 调 `handle.refresh({ force: true })` 后换源 |

## 常见问题

**列表页报错，什么都出不来？**
1. 先确认服务能访问：浏览器打开 `<baseUrl>/healthz`。
2. 如果是网页直连，确认服务端的 CORS 配置里加了你网站的域名。

**列表能出来，点进去播放黑屏？**
1. 检查播放地址是否过期（`handle.expires_at`）。
2. 视频文件是从对象存储直接拉取的，确认对象存储的 CORS 配置放行了你的域名。
3. 确认这个媒资的转码产物是完整的（去管理台看产物列表）。

**播到一半突然失败？**
多半是签名过期了，参考上文「播放器里出现 403 时」手动重签。

**React 里改了清晰度但界面没变？**
`handle` 里的字段会被 SDK 原地更新，但 React 检测不到这种变化。
切换后自己读一遍 `handle` 的最新字段、存成新的 state 就好。

## 用完记得清理

```ts
handle.dispose();  // 停止这个播放的自动续签（服务端会话会自己过期）
sdk.dispose();     // 清掉 SDK 的全部定时器和缓存，之后所有调用都会报错
```
