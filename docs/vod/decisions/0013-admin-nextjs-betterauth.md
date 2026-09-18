# ADR-0013：管理端迁移 Next.js 全栈 + better-auth

- 状态：已接受（用户拍板 2026-09-17：形态 A）
- 日期：2026-09-17
- 关联：ADR-0002（本 ADR 修订其管理端技术栈）、ADR-0012（本 ADR 修订其实现载体，决策意图全部保留）、ADR-0004

## 背景

用户要求管理端采用 **Next.js** 与 **better-auth** 框架。经对比三种形态（Next 全栈 / Next 前端 + Hono API / 仅 better-auth 不用 Next），用户选定 **Next.js 全栈接管管理端**。

## 决策

### 1. 应用形态

- `apps/admin` 重构为 **Next.js（App Router）全栈应用**：UI + API Routes 同应用；
- 原 `apps/admin`（Bun + Hono）与 `apps/admin-web`（Vite SPA）**退役合并**；
- 业务 API 路径 `/v1/admin/*` → `/api/admin/*`（错误信封与契约不变，ADR-0010 的端点语义平移）；
- 部署 = **一个 Node 22 容器**（`next build` + `next start`），UI/API 同源，无 CORS/反代需求。

### 2. 认证：better-auth（取代手写 OIDC/会话）

| ADR-0012 决策 | better-auth 落地 |
|---|---|
| 通用 OIDC（discovery，换 IdP 零代码） | `genericOAuth` 插件（discoveryUrl + clientId/secret + PKCE） |
| 本地兜底账号（双轨） | 内置 email/password（`minPasswordLength: 8`） |
| httpOnly Cookie 会话 | 默认 Cookie 会话，且升级为 **DB 会话（可吊销/踢下线）** |
| BFF（secret 不进浏览器） | 回调与交换在 Next Route Handler（`/api/auth/[...all]`） |

- **Prisma adapter** 复用 `packages/db`；auth 表落现有 schema：`admin_users / admin_sessions / admin_accounts / admin_verifications`（snake_case 列名经 `@map` 保持，模型名映射到 better-auth 的 user/session/account/verification）；
- OAuth 绑定从 `admin_users.oauth_*` 字段迁移到 **account 表**（providerId=`generic-oidc`，accountId=IdP sub）——这是 better-auth 的标准建模；
- 管理端 v1 不做 id_token JWKS 验签的决策保留（backchannel + userinfo）。

### 3. 运行时边界（重要）

- **管理端 = Node 22**（Next.js 官方运行时；Bun 跑 Next 不作承诺）；
- **Worker 仍 Bun**（常驻容器，Prisma 兼容性 P1 验证项继续有效）；
- **分发端仍 Go**（不受影响）。

## 理由

- 管理端本就是「UI + 中后台 API」单体，Next 全栈消除双服务间的会话共享/CORS/代理三类复杂度；
- better-auth 覆盖 ADR-0012 全部决策且 DB 会话更强（吊销即时生效），手写 OIDC/会话代码被标准实现替换是净收益；
- `packages/{db,crypto,storage,transcode,contracts}` 在 Next server 侧照常复用，monorepo 边界不变。

## 备选（否决记录）

- 形态 B（Next 前端 + Hono API）：保留两个运行时与跨服务会话校验，复杂度不降反升 —— 否决。
- 形态 C（仅 better-auth 不用 Next）：与用户意愿不符 —— 否决。
- Auth.js（NextAuth）：配置模型与多框架适配面更广，但 better-auth 的 Prisma/插件体验与 DB 会话设计更贴合本项目 —— 否决。

## 后果与风险

- ADR-0002 管理端「Bun + Hono」条款由本 ADR 取代；`bun --cwd apps/admin dev` 实际拉起 `next dev`（Node）。
- antd v5 + React 19 需 `@ant-design/v5-patch-for-react-19`（官方路径，**在客户端组件 `providers.tsx` 引入一次**；放在 root layout 这类 Server Component 里只有副作用导入的 client reference，浏览器不执行 patch，点击组件（wave）会告警 `antd v5 support React is 16 ~ 18`）。antd v6 需 `@ant-design/pro-components` v3（当前仅 beta 3.1.14-x 支持 antd 6），故暂留 v5 + patch。
- CNB 预览网关会把请求头 `Origin` 改写成 `http://<目标域名>`（TLS 在网关终止），因此 `auth.ts` 除 `ADMIN_TRUSTED_ORIGINS` 外还自动信任 `ADMIN_BASE_URL` 的 http 等同体，并开启 `advanced.trustedProxyHeaders`（前提：管理端只在网关后暴露）。
- `auth.ts` 检测到 `CNB_VSCODE_PROXY_URI`（形如 `https://xxx-{{port}}.cnb.run`）即判定为 CNB 环境，把 `{{port}}` 替换为 `ADMIN_PORT` 后**自动覆盖** `ADMIN_BASE_URL` 与 `ADMIN_TRUSTED_ORIGINS`（CNB 端口映射固定，无需手工维护这两项）。
- Prisma 生成物必须在 `next build` 前生成（`task db:generate`），CI 顺序固化。
- 契约包继续作为 DTO 真相源；Next route handlers 消费 zod schema。
- 单容器后管理端与 Worker 仍分容器部署（ADR-0011 拓扑不变：两应用 = Next 管理端 + Go 分发端，Worker 为管理端侧常驻进程容器）。
