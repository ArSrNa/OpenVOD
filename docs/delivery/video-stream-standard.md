# 分发端视频流获取标准（Standard）

> 适用范围：`apps/delivery`（Go 分发端）向外提供的视频流获取链路，含**明文清单获取**与**加密流（HLS AES-128）获取与解密**的完整规范。
> 读者：AI 助手 / 新接手的工程师。本文为规范性（normative）文档：`必须/禁止/应当` 按 RFC 2119 语义理解。
> 权威来源冲突时以 ADR 为准：ADR-0006（加密与播放密钥）、ADR-0003/0011（部署形态）、ADR-0005（存储）、ADR-0007（鉴权）、ADR-0010（API 面）、`docs/vod/spec.md`。本文是它们在"视频流获取"视角下的汇总与细化，引用处标注了 ADR 编号。

---

## 1. 总览

### 1.1 组件与端口

| 组件 | 技术 | 端口 | 角色 |
|---|---|---|---|
| `apps/delivery` | Go 1.26 + Chi | `:9000`（`DELIVERY_LISTEN`） | 播放热路径 / Data Plane |
| `apps/admin` | Next.js | `:8787` | 控制面，不参与播放字节流 |
| `apps/worker` | Bun + ffmpeg | 无端口 | 转码 + AES-128 加密 + 写 `hls_keys` |
| 存储 | MySQL(TDSQL-C) / SQLite；对象存储 local / S3 兼容(COS/MinIO) | — | 两应用共享一库一桶 |

### 1.2 播放链路总时序（ADR-0006 §3，全系统最重要流程）

```
App                        delivery                      存储/DB
 │  POST /v1/auth/login      │                              │
 │ ────凭据(bcrypt)──────────▶ 签发 ES256 JWT (24h)          │
 │  POST /v1/media/{id}/play  │                              │
 │ ────JWT───────────────────▶ 建/复用 playback_session       │
 │ ◀──manifest_url(含typ=m token)──┘                         │
 │  GET manifest/master.m3u8?t=<m>                           │
 │ ─────────────────────────▶ 校验token+会话 → 读 proceed/{id}/[tpl/]master.m3u8
 │ ◀──改写后主清单(子清单URL注入m token, no-store)──│         │
 │  GET manifest/{variant}/index.m3u8?t=<m>                  │
 │ ─────────────────────────▶ 改写子清单：EXT-X-KEY URI→typ=k token
 │ ◀──改写后子清单(分片URL注入签名直出URL, no-store)          │
 │  GET 分片 URL（S3 预签名 或 CDN 鉴权，ADR-0019）            │
 │ ─────────────────────────▶ 客户端直连存储/CDN（分片直出）  │
 │ ◀──分片字节（视频字节不经过函数，P0）                       │
 │  GET /v1/media/{id}/key?t=<k>                             │
 │ ─────────────────────────▶ 解封 hls_keys.wrapped_cek      │
 │ ◀──16B 裸 CEK（no-store）──┘                              │
 │  播放器本地 AES-128 解密分片并播放                          │
```

### 1.3 核心设计约束（为什么是这样）

1. **播放资源鉴权必须全部走 URL query 签名 token，不依赖请求头**（ADR-0006 §4 / ADR-0007）。根本原因：Safari 原生 HLS 的分片与密钥请求无法携带自定义请求头。JWT 只用于 login / media / play 业务 API。
2. **分片字节永远不经过云函数**（P0，ADR-0003/0005）。分片一律由客户端直连存储 / CDN 获取：默认 `s3_presign`（S3 预签名直出），或 `cdn_url_auth`（CDN 私有回源 + 边缘 URL 鉴权，ADR-0019 / spec.md §6.7，EO Token 鉴权 A/B/C/D/V 全内置）；local 驱动与分发端代理已随 ADR-0005 2026-09-22 修订移除。
3. **m3u8、key 与字幕 `.vtt` 响应必须 `Cache-Control: no-store`**（P0，ADR-0006 §5 / spec.md §7.5）。清单内含一次性 token，绝不允许进 CDN/边缘缓存；字幕文本可就地覆盖（编辑后下一次请求必须取到新文本）。CI 门禁：`assert-unsigned-403` / `assert-no-store`。
4. **明文 CEK 只存在于转码瞬间与密钥接口响应瞬间**（P0，ADR-0006 §1）。日志与响应中绝不出现任何密钥材料。

---

## 2. 两套鉴权体系（勿混用）

| | 业务 API 鉴权 | 播放资源鉴权 |
|---|---|---|
| 凭据 | ES256 JWT（`Authorization: Bearer`） | URL 签名 token（HMAC-SHA256） |
| 签发方 | delivery（`/v1/auth/login`） | delivery（play 与清单改写时动态签发） |
| 载体 | 请求头 | URL query `?t=`（首选）或 header `X-Playback-Token`（兜底） |
| 状态 | 自包含，24h（`DELIVERY_JWT_TTL_SEC`），v1 无 refresh | 绑定 `playback_sessions`，**每请求查库校验存活** |
| 密钥 | `signing_keys`（kind=JWT, state=ACTIVE），私钥以 MK 封装：`private_enc = hex(MK(P-256标量32B))` | `URL_SIGN_KEY_HEX` + `URL_SIGN_KEY_KID`（默认 `urlsign-v1`） |

JWT claims：`iss`（默认 `openvod-delivery`）/ `sub` / `iat` / `exp` / `jti` / `kid`。

---

## 3. URL 签名 Token 规范（ADR-0006 §4）

### 3.1 格式

```
token = b64url(JSON(payload)) + "." + b64url(HMAC-SHA256(URL_SIGN_KEY, payload))
```

- base64 使用 **RawURL** 编码（URL-safe、无 padding）。
- 实现：`apps/delivery/internal/token/token.go`（Go）与 `packages/crypto/src/token.ts`（TS）双端互通，向量在 `packages/crypto/fixtures/crypto-v1.json`。**改任一侧必须重跑 `task vectors` 与两端测试**。

### 3.2 Payload（字段顺序即规范）

| 字段 | 类型 | 含义 |
|---|---|---|
| `ver` | int | 恒为 `1` |
| `typ` | string | 用途绑定：`m` 清单 / `s` 分片 / `k` 密钥 / `v` 字幕（`packages/shared TOKEN_TYPES`） |
| `mid` | string | 媒资 ID（防跨媒资重放） |
| `sid` | string | 播放会话 ID（`ps_` + 12 字节随机 hex），吊销锚点 |
| `exp` | int64 | 过期时间（Unix 秒），`<= now` 即拒绝 |
| `kid` | string | 签名密钥 ID |

### 3.3 校验规则（实现：`token.Verify`，顺序固定）

1. 格式：必须恰含一个 `.`，两段均可 b64url 解码；
2. 按 `kid` 查找密钥，未知 kid 拒绝；
3. HMAC 用 `subtle.ConstantTimeCompare` **恒时比较**；
4. `exp <= now` 拒绝；
5. `typ` 必须匹配端点用途（key 接口必须 `typ=k`）；
6. `mid` 必须匹配 URL 中的媒资 ID。

### 3.4 会话校验（token 之外的第二道门）

`authorize()`（server.go L570）在验签后**每个请求**查库 `SessionAlive`（`playback_sessions`：`revoked_at IS NULL AND expires_at > now` 且 `media_id` 匹配），失败返回 `403 bad_token`。即：吊销会话后，新清单/密钥请求立即被拒（实现比 ADR 写的"≤60s 缓存"更严格）。

### 3.5 Token 有效期约束

```
token.exp = min(会话 expires_at, 签发时刻 + PLAYBACK_MANIFEST_TTL_SEC)
```

默认：会话 TTL `PLAYBACK_SESSION_TTL_SEC=14400`（4h）、清单 TTL 上限 `PLAYBACK_MANIFEST_TTL_SEC=14400`（4h）。子清单内 key/segment token 的 exp 与其清单 token 相同。已下发分片在 token exp 内仍可播（接受窗口，ADR-0006 §6）。

字幕 token（typ=v）的 exp 另按 `PLAYBACK_SUBTITLE_TTL_SEC`（默认 86400，即比分片长）与**会话 exp** 取较小值；由 `play` 随响应一次性签发（token 绑定 mid + sid，不绑定具体轨道），见 §4.8。

---

## 4. API 规范

错误信封统一为 `{"error":{"code":"...","message":"..."}}`（`packages/contracts ErrorEnvelope`）。错误码全集：`unauthorized / invalid_credentials / forbidden / bad_request / bad_token / not_found / not_playable / session_limit / rate_limited / not_implemented / internal`。

### 4.1 端点总表（当前实现，server.go）

| 方法/路径 | 鉴权 | 成功响应 | Cache-Control |
|---|---|---|---|
| `GET /healthz` | 无 | `{"status":"ok","app":"delivery"}` | — |
| `POST /v1/auth/login` | 凭据 | `{token, user...}`（LoginResponse） | no-store 语义 |
| `GET /v1/media` | JWT | 媒资分页列表（仅 READY，limit≤200 默认 50） | — |
| `GET /v1/media/{id}` | JWT | 媒资详情 | — |
| `POST /v1/media/{id}/play` | JWT | `PlaybackResponse` | — |
| `GET /v1/media/{id}/manifest/master.m3u8` | token(m) | 改写后主清单 `application/vnd.apple.mpegurl` | **no-store** |
| `GET /v1/media/{id}/manifest/*` | token(m) | 改写后子清单 | **no-store** |
| `GET /v1/media/{id}/key` | token(k) | **16B 裸 CEK** `application/octet-stream` | **no-store** |
| `GET /v1/media/{id}/subtitles/{trackId}.vtt` | token(v) | 字幕 WebVTT `text/vtt; charset=utf-8`（分发端代理输出，见 §4.8） | **no-store** |

### 4.2 登录 `POST /v1/auth/login`

- 请求体：`LoginRequest { username, password }`（bcrypt 校验，cost ≥ 12）。
- 无 ACTIVE JWT 签名密钥时返回 `503 internal`（启动不因此失败）。
- 成功：`LoginResponse`，`token` 即后续业务 API 的 Bearer JWT。
- 限频：v1 未实现（TODO）。

### 4.3 创建播放 `POST /v1/media/{id}/play`

请求体（`PlaybackRequest`，契约源 `packages/contracts/src/index.ts`）：

| 字段 | 类型 | 语义 |
|---|---|---|
| `force_new` | boolean? | 默认 `false`：幂等复用同用户同媒资的未过期会话；`true` 强制新建 |
| `template_id` | string? | 指定模板产物；空串 = 显式请求旧布局（`proceed/{id}/` 直挂产物）；缺省 = 自动选择 |

响应（`PlaybackResponse`）：

```json
{
  "sid": "ps_ab12...",
  "manifest_url": "{PUBLIC_BASE_URL}/v1/media/{id}/manifest/master.m3u8?t=<m token>&tpl=<templateId>",
  "expires_at": "2026-09-18T12:00:00Z",
  "template_id": "c..."
}
```

模板选择规则（`resolveTemplate`，server.go L345）：

1. 显式指定 → 必须存在，否则 `409 not_playable`（消息列出可选值）；
2. 唯一模板产物 → 直接使用；
3. 多套 → 取 `transcode_templates.is_default` 那套；无默认 → `409 not_playable` 要求指定；
4. 无模板子树 → 旧布局 `proceed/{id}/{variant}/`（响应 `template_id` 为空串）。

模板产物识别：`proceed/{id}/` 下一级子前缀中匹配 `^c[a-z0-9]{20,}$`（cuid）且非保留段 `subtitles`。

其他错误：媒资非 READY → `409 not_playable`；并发超限（`users.max_concurrent_sessions > 0` 时）→ `409 session_limit`。

**客户端必须原样使用 `manifest_url`**，不得拆改 query。

### 4.4 主清单 `GET /v1/media/{id}/manifest/master.m3u8`

- 鉴权：token(m)（`?t=` 或 `X-Playback-Token`）+ 会话存活；`tpl` query 必填且须为 cuid 形状（旧布局传空串）。
- 行为：从存储读 `proceed/{id}/[tpl/]master.m3u8` 原文，**行级改写**：每条非注释行（变体行）整体替换为

  ```
  {PUBLIC_BASE_URL}/v1/media/{id}/manifest/{path.Clean(变体名)}?t=<新签 m token>&tpl=<tpl>
  ```

  子清单 token 与授权 token 同 exp（复用授权 token 的 `p.Exp`）。注释行/空行原样保留。

### 4.5 子清单 `GET /v1/media/{id}/manifest/{variant}/index.m3u8`

- 鉴权同上；路径白名单 `^[A-Za-z0-9._-]+(/[A-Za-z0-9._-]+)*$`，禁止 `..` 与绝对 URL。
- 改写规则（`playback.Rewriter.RewriteVariant`，纯函数 `internal/playback/playlist.go`）：

| 行类型 | 规则 |
|---|---|
| `#EXT-X-KEY:` | 仅替换 `URI="..."` 值为 `{base}/v1/media/{id}/key?t=<k token>`；METHOD/IV 等其他属性原样保留 |
| `#EXT-X-MAP:` | 同 EXT-X-KEY 规则改写（fMP4 演进路径，v1 TS 产物不出现） |
| 其他 `#` 标签（EXTINF / EXT-X-ENDLIST / EXT-X-MEDIA…） | 原样保留（字幕**不入清单**：v1 由 `play` 返回外挂轨道 URL，spec.md §7.5） |
| 分片行（默认） | 整行替换，见下 |

- 分片 URL 注入（相对名以子清单所在目录拼接）：
  - `Blob.PresignGet(storageKey, PLAYBACK_MANIFEST_TTL_SEC)` 按 `storage_sign_mode` 生成签名 URL——默认 **S3/COS 预签名 GET URL**，或 `cdn_url_auth` 的 **CDN 鉴权 URL**（ADR-0019 / spec.md §6.7；两种模式分片字节都不经过函数，P0）。
- key token 在改写开始前一次性签好，exp 与清单 token 相同。

### 4.6 密钥接口 `GET /v1/media/{id}/key`（加密流核心）

1. 鉴权：token(**k**) + 会话存活。
2. 查 `hls_keys`（`media_id` 一对一）：无行 → `404 not_found`（未加密或产物未就绪）。
3. 按 `row.MkVer` 从 `MASTER_KEYS` 取对应版本的 MK；缺版本 → `500 internal`（提示轮换需保留旧版本）。
4. `mk.UnwrapHex(MK, wrapped_cek)`：MK 封装格式为 `iv(12B) || ciphertext || tag(16B)` 整体 hex，AES-256-GCM；认证失败即报错，绝不返回半成品 → `500 internal "密钥不可用"`。
5. 成功响应：

```
200 OK
Content-Type: application/octet-stream
Cache-Control: no-store
Content-Length: 16
<body: 16 字节裸 CEK>
```

### 4.7 分片获取（签名直出）

| | 说明 |
|---|---|
| URL 形态 | `s3_presign`（默认）：S3/COS 预签名 URL（可经 `STORAGE_CDN_BASE_URL` 换加速域名 origin）；`cdn_url_auth`：CDN 私有回源 + 边缘 URL 鉴权（EO Token 鉴权 A/B/C/D/V，`storage_cdn_auth_type` 选择，ADR-0019 / spec.md §6.7） |
| 字节路径 | **不经过函数**（P0），客户端直连存储/CDN |
| 校验 | `s3_presign`：预签名自身即鉴权（TTL 与清单 token 对齐）；`cdn_url_auth`：CDN 边缘验签（密钥双侧一致）+ 私有回源凭证 |
| 演进 | local 驱动分发端代理已随 ADR-0005 2026-09-22 修订移除（存储仅 S3） |

### 4.8 字幕 `GET /v1/media/{id}/subtitles/{trackId}.vtt`（spec.md §7.5）

1. `trackId` 形状白名单（cuid 形状，与模板 ID 同形）→ 不符 `404`（兼作路径注入防护）；
2. 鉴权：token(**v**) + 会话存活（未过期未吊销）→ 未带 / 非法 / 已吊销 → `403 bad_token`；
3. 查 `media_subtitles`：`id = trackId AND media_id = {id} AND status = 'READY'` → 不存在 `404`；
4. 读对象**以行内 `storage_key` 为准**（不按 URL 拼键，键可迁移）：`proceed/{id}/subtitles/{trackId}.vtt`；
5. **输出：两种驱动都由 delivery 代理输出**（`Blob.Get`）——
   - 为什么不用 s3 预签名 302：对象响应头与跨域策略都不受 delivery 控制，而 `no-store` 是字幕「就地覆盖、下一次请求即生效」的前提；
   - 字幕 ≤5 MiB（管理端上传上限），低于 P0 的 6MB 响应体约束；P0 的「字节不经过函数」只约束**分片**；
6. 响应：`Content-Type: text/vtt; charset=utf-8`、`Cache-Control: no-store`、`Content-Length`。

字幕 URL 的领取方式：`play` 响应 `subtitles[]`（`{id, lang, label, is_default, url}`，`url` 已带 typ=v token）；`GET /v1/media/{id}` 只给轨道元信息（无 URL）。播放端以**外挂轨道**引用（`<track>` / hls.js `addTextTrack`），`EXT-X-MEDIA TYPE=SUBTITLES` 为演进项（ADR-0009）。

---

## 5. 加密流解密规范（播放器视角）

1. 子清单中 `#EXT-X-KEY: METHOD=AES-128, URI="...?t=<k>", IV=0x...`（IV 由转码期随机生成并显式写入清单，ADR-0006 §1）。
2. 播放器请求 URI 取回 **16B CEK**（即 AES-128 密钥），本地按 AES-128-CBC（PKCS7）以清单 IV 解密每个分片。
3. 密钥请求失败 → 播放中断；token 过期或会话被吊销 → `403 bad_token`。
4. 换码率 = 请求另一条子清单（同一把 m token 或其派生链），key URI 由各子清单改写注入，CEK 相同（每媒资一份 CEK，非每会话加密——备选方案已被 ADR-0006 否决）。

### 5.1 密钥分层（ADR-0006 §1，理解 key 接口的前提）

```
MK（env MASTER_KEYS="版本:64位hex"，逗号分隔多版本，每版必须 32B）
 ├─wrap→ CEK（16B AES-128，每媒资随机一份，hls_keys.wrapped_cek + mk_ver）
 ├─wrap→ JWT ES256 私钥（signing_keys.private_enc = hex(MK(P-256标量32B))，无 mk_ver 列 → 启动按版本从大到小逐个尝试解封）
 └─wrap→ CDN 边缘鉴权密钥（`storage_cdn_auth_key`，ADR-0019）：cdn_url_auth 模式使用，
         secret 经 MK 封装入 system_settings（`signing_keys.kind=EO_TYPEA` 为历史废弃枚举，不再使用）
```

MK 轮换语义：新版本加进 `MASTER_KEYS` 且**保留旧版本**，`hls_keys` 按各自 `mk_ver` 解封，免重转码。

---

## 6. 配置参考（delivery 侧环境变量）

| 变量 | 默认 | 说明 |
|---|---|---|
| `DELIVERY_LISTEN` | `:9000` | 监听地址（SCF Web 函数固定 9000） |
| `DATABASE_URL` | 无（必填） | 三端共用。MySQL（归一为 go-sql-driver DSN：`parseTime=true&loc=UTC&charset=utf8mb4`）或 SQLite（`file:` / `sqlite:`，单机同卷） |
| `DELIVERY_PUBLIC_BASE_URL` | `http://127.0.0.1:{port}` | 清单/密钥/字幕 URL 基址 |
| `URL_SIGN_KEY_HEX` / `URL_SIGN_KEY_KID` | 必填 / `urlsign-v1` | 播放 token HMAC 密钥 |
| `MASTER_KEYS` | 必填 | `版本:64位hex`，每版必须 32B，多版本逗号分隔 |
| `DELIVERY_JWT_ISSUER` / `DELIVERY_JWT_TTL_SEC` | `openvod-delivery` / `86400` | JWT 签发参数 |
| `PLAYBACK_SESSION_TTL_SEC` / `PLAYBACK_MANIFEST_TTL_SEC` | `14400` / `14400` | 会话 TTL / token exp 上限 |
| `PLAYBACK_SUBTITLE_TTL_SEC` | `86400` | 字幕 token 有效期上限（实际取与会话 exp 的较小值，§4.8） |
| `DELIVERY_CORS_ORIGINS` | `*` | CORS 白名单；暴露 `Content-Length/Content-Range/Accept-Ranges`，允许 `X-Playback-Token`、`Range` 头 |
| `STORAGE_ROOT_PREFIX` | 空 | 全局 root 前缀 |
| `S3_ENDPOINT/REGION/BUCKET/ACCESS_KEY_ID/SECRET_ACCESS_KEY/FORCE_PATH_STYLE` | 必填 | S3 兼容存储（唯一驱动）；COS 必须显式 `S3_FORCE_PATH_STYLE="false"`（virtual-hosted-style） |

DB 账号分权（硬约束，ADR-0011）：delivery 使用受限账号——`users / media / media_subtitles / hls_keys / signing_keys / transcode_templates` 只读 + `playback_sessions` 读写，其余拒绝；**绝不共用管理端全权账号**。

---

## 7. P0 硬约束清单（违反即事故 / CI 门禁）

1. 未携带合法 token 的清单/密钥/分片/**字幕**请求必须 `403`（CI：`assert-unsigned-403`）。
2. m3u8（主/子）、`/key` 与字幕 `.vtt` 响应必须 `Cache-Control: no-store`（CI：`assert-no-store`）。
3. 分片字节不经过函数（S3 预签名直出）；回源代理与 local 驱动代理模式均已被否决（ADR-0005）。
4. 明文 CEK 不落日志、不落存储、不入契约 DTO；日志中的密钥操作只记事件不记材料。
5. 转码禁止上任何函数；delivery 响应体 ≤6MB（清单远小于此，`blob.Get` 读取上限 8MB 为余量）。
6. token 校验必须恒时比较；`typ`/`mid` 绑定校验不可省略。
7. 清单/密钥每请求查会话库（吊销即时收敛）；禁止给播放资源加边缘缓存。

---

## 8. 当前实现状态与演进项（截至本文撰写）

**已落地**：login(JWT)、media 列表/详情、play（会话幂等 + 并发上限）、主/子清单行级改写、key 接口（MK 解封 CEK）、签名直出（`s3_presign` 默认；`cdn_url_auth` = CDN 私有回源 + EO Token 鉴权 A/B/C/D/V 全内置，ADR-0019）、`STORAGE_CDN_BASE_URL` 加速域名、播放域名 DB 覆盖（`playback_base_url` 60s 缓存）、模板产物探测（`resolveTemplate`）。（ADR-0005 2026-09-22 修订：local 分片流式输出已随仅-S3 决策删除）

**未落地（演进项，勿当作既有能力）**：

| 项 | 状态 | 依据 |
|---|---|---|
| 字幕分发（typ=v） | **已实现**（play 下发签名 URL + `.vtt` 代理输出，spec.md §7.5） | ADR-0009 |
| ~~EdgeOne TypeA URL 鉴权 + 私有回源~~ | **已实现（2026-10-09；2026-10-17 扩展为 EO Token 鉴权 A/B/C/D/V 全内置）**：`cdn_url_auth` 模式，管理端可配（默认仍为 `s3_presign`） | ADR-0019 / spec.md §6.7 |
| 登录/play 限频 | 未实现（代码有 TODO） | ADR-0010 |
| 吊销 60s 进程内缓存 | 实现为每请求查库（更严格） | ADR-0006 §6 |
| poster 直出、`custom_data` 公开白名单 | poster_url 预签名直出（S3-only 后全量生效）；custom 回传空对象 | spec.md §6.6 |

---

## 9. AI 阅读速查（关键事实浓缩）

- 播放入口永远从 `POST /v1/media/{id}/play` 拿 `manifest_url` 开始，之后不再需要 JWT；同一响应还带 `subtitles[]`（每条含 typ=v 签名 `url`），字幕不入清单（§4.8）。
- token 类型：`m` 清单 / `k` 密钥 / `v` 字幕（`s` 分片型常量保留但不再签发——分片走签名直出，见 §4.7）；传递 `?t=` 优先，header `X-Playback-Token` 兜底。
- key 接口返回的是 **16 字节二进制**，不是 JSON；用 `Content-Length: 16` 与 `application/octet-stream` 识别。
- 加密方式：HLS SAMPLE-AES 之外的 **AES-128（METHOD=AES-128, CBC, 清单显式 IV）**，每媒资一把 CEK。
- 分片 URL：清单中直接是签名直出 URL（无 `t` 参数）——`s3_presign` 为 S3/COS 预签名；`cdn_url_auth` 为 CDN 鉴权 URL（EO Token 鉴权 A/B/C/D/V）。
- `tpl` query：模板布局必填 cuid；旧布局传空串。
- 代码索引：路由 `internal/server/server.go`；token `internal/token/token.go`；清单改写 `internal/playback/playlist.go`；CEK 解封 `internal/mk/mk.go`；存储 `internal/blob/blob.go`；读模型/会话 `internal/store/store.go`；DTO `internal/contracts/`（生成物，源在 `packages/contracts`）。
