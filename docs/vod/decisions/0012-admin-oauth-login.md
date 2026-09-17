# ADR-0012：管理端 OAuth 登录（OIDC + PKCE，双轨账号）

- 状态：已接受（实现载体经 **ADR-0013 修订**：手写 OIDC/会话 → better-auth，决策意图全部保留）
- 日期：2026-09-17
- 关联：ADR-0002、ADR-0004、ADR-0007（本 ADR 修订其「v1 不做 SSO / OAuth」条款）、ADR-0013

## 背景

管理端控制台需要企业级登录方式；自管密码存在弱口令与运维负担。用户要求以 OAuth 登录进入管理端。**范围仅管理端**（`admin_users`）；播放端用户体系（`users`，分发端签发 JWT，ADR-0007）不受影响。

## 决策

### 1. 协议与形态：通用 OIDC，BFF 模式

- 环境变量配置（换 IdP 零代码改动）：`OIDC_ISSUER / OIDC_CLIENT_ID / OIDC_CLIENT_SECRET / OIDC_REDIRECT_URI`；
- discovery 自动获取 endpoints（`{issuer}/.well-known/openid-configuration`），可接腾讯云 SSO、Keycloak、Auth0、Logto、GitLab 等任何标准 IdP；
- **Authorization Code + PKCE(S256) + state/nonce**；回调与 code→token 交换在 **admin 后端**完成（BFF），`client_secret` 不进浏览器；
- 身份取自 **userinfo 端点**（Bearer access token 回源获取），管理端 v1 不做 id_token JWKS 验签（confidential client backchannel 置信足够；升级为 id_token 验签列入 spec 可选项）。

### 2. 会话：httpOnly Cookie

- OIDC 成功后由 admin 签发**HMAC 签名的短期会话 Cookie**（默认 8h，`ADMIN_SESSION_TTL_SEC`）；
- `HttpOnly + SameSite=Lax + Path=/`，生产加 `Secure`；SPA 全程不接触凭据；
- 与播放端 JWT 体系完全分离（不同密钥、不同载体），控制台 API 以 Cookie 鉴权。

### 3. 账号双轨（用户拍板：保留本地兜底）

- `admin_users` 增加 `oauth_issuer / oauth_sub` 绑定（复合唯一），**首登自动建档**；
- 本地 bcrypt 账号保留：登录页 OIDC 按钮与本地表单并存；IdP 故障时救急；
- 登录事件写 `audit_logs`（open-questions #14 范围包含登录）。

### 4. 安全要点

- state / code_verifier / nonce：进程内存暂存，TTL 10 分钟（单实例）；**多实例部署时需外置**（加密 Cookie 或 DB，spec 落）；
- CSRF：JSON API + `SameSite=Lax` 已挡住跨站表单/简单请求携带 Cookie；后续敏感操作按需加 CSRF token；
- OAuth-only 账号 `password_hash` 置空串且不可本地登录。

## 备选（否决记录）

- GitHub / 企业微信 / 钉钉直连：非标准 OIDC，绑定单一 IdP，适配代码随平台走 —— 否决（用户选通用 OIDC）。
- 纯 OAuth 无兜底：IdP 故障即失联 —— 否决（用户要求保留本地账号）。
- SPA 直接持 access/refresh token：凭据进 JS 运行时，XSS 面大 —— 否决（BFF + Cookie）。

## 后果与风险

- 管理端多实例横向扩展需先解决 state 外置（本条进 specification 检查单）。
- 新增依赖：`bcryptjs`（本地账号校验）；OIDC 交互用原生 fetch 手写（discovery/exchange/userinfo 均 1 个请求，无需 SDK）。
- 实现落位：`apps/admin/src/auth/{env,oidc,session,routes}.ts`；前端 `apps/admin-web/src/pages/Login.tsx` + 路由守卫。
