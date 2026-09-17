# ADR-0007：鉴权与用户体系（JWT / 播放会话）

- 状态：已接受（用户拍板：分发端签发 JWT；B 端 API Key 留待后续）
- 日期：2026-09-17
- 关联：ADR-0004、ADR-0006、ADR-0010

## 背景

用户体系在管理端配置，双端共享数据库。分发端是播放端 App 的唯一 API 入口；用户应用逻辑：App 带 JWT 调分发端 → 获得签名 CDN URL → 密钥 API 取密钥播放。

## 决策

### 账户域

- `users`：播放端用户（管理端 CRUD：创建 / 封禁 / 重置密码 / 并发上限）；分发端登录校验。
- `admin_users`：管理端控制台账号，独立于 users（不同口令策略与会话体系）。
- 口令哈希：**bcrypt**（cost ≥12）—— TS 与 Go 生态 `$2a/$2b` 格式互通（管理端建用户、分发端验登录跨语言安全）。

### JWT（播放端）

- 算法 **ES256（P-256）**，`kid` 版本化；密钥表 `signing_keys`（私钥以 MK 封装入库，ADR-0006）。
- 签发方：**分发端** `POST /v1/auth/login`（用户拍板）；管理端只负责用户与密钥生命周期，不参与登录链路。
- Claims：`iss=openvod-delivery, sub=uid, iat, exp, jti, kid`；默认 TTL 24h（可配）；v1 不做 refresh token（open-questions #6）。
- 验签：分发端启动加载 active keys；未命中 kid 回源 DB 并缓存 60s；轮换为双 kid 宽限窗口。

### 播放会话（关联 ADR-0006）

- `POST /v1/media/{id}/play`（JWT）→ 创建 `playback_sessions(sid, uid, media_id, expires_at≈4h, revoked_at)`，返回签名清单 URL；
- 清单 / 密钥 / 字幕的签名 token 绑定 sid：吊销即时收敛于新请求（会话状态进程内缓存 ≤60s）；
- 并发会话上限按用户可配（0 = 不限）；封禁用户 → 登录拒绝 + 全会话吊销。

### 管理端自身鉴权

- ~~控制台登录 → 短期 Bearer JWT（独立密钥）；v1 不做 SSO / OAuth~~ **已修订（ADR-0012）**：控制台登录 = 通用 OIDC（Authorization Code + PKCE，BFF 换发）+ 本地 bcrypt 账号兜底，会话以 httpOnly Cookie 承载（HMAC 签名短期会话，与播放端 JWT 体系分离）；敏感操作写审计日志（范围 open-questions #14）。

### 资源鉴权总表

| 资源 | 鉴权 |
|---|---|
| POST /v1/auth/login | 凭据 |
| GET /v1/media、GET /v1/media/{id} | Bearer JWT |
| POST /v1/media/{id}/play | Bearer JWT |
| m3u8 / 分片 / key / 字幕 | 签名 token（query）—— **不依赖请求头** |

> 关键理由：Safari 原生 HLS 的分片与密钥请求无法自定义请求头，因此播放链路的资源鉴权必须全部走 URL 签名 token；JWT 的职责收敛在 login / media / play 等业务 API 上。

## 理由

- ES256 非对称：分发端即便被攻破，验签方公钥也不构成伪造能力；kid 轮换简单。
- bcrypt 双语言互通成熟，避免 argon2 参数漂移风险；在「管理端创建、分发端验证」的频率下性能可接受。
- 分发端签发让登录流量不经过控制面（用户拍板）。

## 备选（否决 / 搁置）

- 管理端统一签发 JWT：登录流量过控制面，分发端热点路径被拉长 —— 否决。
- HS256 共享密钥：实现最少，但密钥落两端，泄漏半径大 —— 否决。
- argon2id：更强，但双语言互通与参数管理成本高于收益 —— v1 不取。
- B 端服务器对服务器 API Key：预留 `signing_keys.kind=api_key`，v1 不实现（open-questions #7）。

## 后果与风险

- 封禁 / 吊销对「已下发分片 token」在 exp 内仍有效（ADR-0006 已声明接受）。
- JWT 私钥入 DB（MK 封装）+ 进程内存缓存；密钥接口与签发接口的审计为 P1。
