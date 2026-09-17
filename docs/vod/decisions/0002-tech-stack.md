# ADR-0002：双端技术栈

- 状态：已接受（分发端语言为用户拍板；管理端沿用开发镜像既定方向）
- 日期：2026-09-17
- 关联：ADR-0001、ADR-0003、ADR-0004

## 背景

分发端是热路径 API（清单改写、密钥下发、URL 签名），需跑在 EdgeOne Cloud Functions 或 SCF 容器；管理端是控制面（媒资 / 用户 / 密钥 / 转码调度），跑在常驻容器。数据库与 ORM 见 ADR-0004。

## 决策

### 分发端 Data Plane — `apps/delivery`

| 层 | 选型 | 说明 |
|---|---|---|
| 语言 | Go 1.26 | EdgeOne Cloud Functions 原生运行时；静态二进制可直接进 SCF 容器 |
| 路由 | Chi | EdgeOne 官方点名支持（Chi / Echo / Gin / Fiber），最贴标准库、依赖最少 |
| DB 访问 | `database/sql` + sqlx | 只读读模型 + 播放会话写入；schema 由 Prisma 管理（ADR-0004） |
| JWT | ES256（P-256） | stdlib `crypto/ecdsa` 或 golang-jwt；kid 轮换见 ADR-0007 |
| URL 签名 | HMAC-SHA256 | stdlib `crypto/hmac`；与 TS 侧共享测试向量（ADR-0001） |
| 配置 | 环境变量 | 12-factor；`edgeone.json` / SCF 环境注入 |

### 管理端 Control Plane — `apps/admin`（Next.js 全栈）/ `apps/worker`

> **修订（ADR-0013，2026-09-17）**：原「Bun + Hono + Vite SPA」由 **Next.js 全栈（Node 22）+ better-auth** 取代；Worker 仍 Bun。

| 层 | 选型 | 说明 |
|---|---|---|
| 框架 | **Next.js（App Router）** | UI + API Routes 同应用，一个 Node 22 容器（ADR-0013） |
| 认证 | **better-auth**（Prisma adapter + genericOAuth 插件） | OIDC + 本地邮箱密码双轨；DB 会话可吊销 |
| 运行时 | Node 22 | Next.js 官方运行时 |
| ORM | Prisma | schema / 迁移唯一真相源，双方言（ADR-0004） |
| 校验 | zod（contracts 包） | API DTO 唯一真相源 |
| UI | React + **Ant Design** + TanStack Query | 组件库用户已定 antd（open-questions #10） |
| Worker | Bun + ffmpeg / Bento4 子进程 | 常驻容器专用，禁止上函数（P0） |
| 任务队列 | DB 表 + SKIP LOCKED（MySQL）/ CAS（SQLite） | 不引入 Redis（ADR-0004） |

## 理由

- Go 静态二进制在「EdgeOne CF（Go 1.26 运行时）」与「SCF 容器」两个目标间零改动迁移，正中部署需求。
- 管理端是 IO 编排型负载，Bun/Hono 足够；转码 / 加密等重逻辑全部在常驻容器侧。
- 双语言的代价集中在契约同步，已由 ADR-0001 生成式契约消化。

## 备选（否决 / 搁置）

- 分发端 TypeScript + Hono：同语言效率最高，但放弃 EdgeOne CF Go 原生运行时与静态二进制优势 —— 用户已定 Go。
- 管理端 Bun + Hono + Vite SPA：前期选型，**已被 ADR-0013（Next.js 全栈 + better-auth）取代**。
- 管理端 NestJS：依赖重 —— 否决。
- 分发端 GORM：对只读场景过重，且 schema 已由 Prisma 管理，双 ORM 漂移风险大 —— 否决。

## 后果与风险

- Go 侧需维护与 Prisma schema 对齐的读模型（集成测试兜底，ADR-0004）。
- Bun + Prisma 组合为 P1 验证项（ADR-0004）。
- EdgeOne Edge Functions（JS）仅作为后续可选加速层（URL 预校验 / 重定向），v1 不承载业务（无 npm、CPU 200ms 限制）。
