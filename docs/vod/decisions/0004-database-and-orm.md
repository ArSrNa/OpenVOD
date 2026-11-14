# ADR-0004：数据库与 ORM（Prisma 双方言）

- 状态：已接受（用户拍板：Prisma；底层数据库 MySQL(TDSQL-C) 或 SQLite）
- 日期：2026-09-17
- 关联：ADR-0002、ADR-0008

## 背景

双端共享一个数据库：管理端负责写入与迁移；分发端读用户 / 媒资 / 字幕 / 密钥，写播放会话。用户决定使用 **Prisma**，底层可在 **MySQL(TDSQL-C)** 与 **SQLite** 间选择。（覆盖前期文档的 Drizzle 建议。）

## 决策

- **ORM / 迁移：Prisma，唯一 schema 真相源**（`packages/db`）。
  - 生产 = TDSQL-C MySQL（`prisma migrate deploy`）；
  - 开发与小型自托管 = SQLite（`prisma db push` 同步）。
- **双方言机制**：单一模型定义源 → 脚本生成 `schema.mysql.prisma` / `schema.sqlite.prisma` 两份（或人工双文件 + CI 一致性断言）；方言差异清单纳入 CI 检查。
- **分发端（Go）不使用 Prisma**：以 `database/sql + sqlx` 实现只读读模型与播放会话写入，对齐 Prisma 管理的表结构；CI 在迁移后的 MySQL / SQLite 上跑 Go 仓储集成测试防漂移。

### v1 表清单（初稿，specification 细化）

| 表 | 写方 | 读方 | 说明 |
|---|---|---|---|
| users | 管理端 | 分发端 | 播放端用户；bcrypt 摘要；状态 / 封禁 |
| admin_users | 管理端 | 管理端 | 控制台账号，与 users 分离 |
| signing_keys | 管理端 | 分发端 | 密钥材料（kind 区分）：JWT ES256 密钥对、URL 签名 HMAC 密钥（EO TypeA 鉴权密钥已随 2026-09-20 ADR-0005 修订废弃，枚举保留不接入）；私密部分以 MK 封装；kid 版本化 |
| media | 管理端 | 分发端 | 媒资：标题、状态、系统 probe 元数据(JSON)、自定义数据(JSON)、产物展示与默认设置(JSON，ADR-0021)、存储引用 |
| media_subtitles | 管理端 | 分发端 | WebVTT 轨道（lang / label / default / 存储引用） |
| transcode_templates | 管理端 | Worker | 转码模板（参数 JSON + 加密开关 + 保持原配置，ADR-0014） |
| transcode_jobs | 管理端 / Worker | 管理端 | 转码任务队列（状态机 + lease；发起时快照模板进 template_snapshot，ADR-0014） |
| hls_keys | Worker 写 | 分发端 | 每媒资 CEK：wrapped_cek、mk_ver、iv、kid |
| playback_sessions | 分发端 | 分发端 / 管理端 | 播放会话：uid / media / exp / revoked（可吊销） |
| audit_logs | 管理端 | 管理端 | 控制台敏感操作审计（范围待定，open-questions） |

### 任务队列实现（不引入 Redis）

- MySQL：`SELECT ... FOR UPDATE SKIP LOCKED` 认领（Worker 侧 `$queryRaw`）；
- SQLite：单 Worker + CAS 状态更新；
- 任务带 `lease_until`，Worker 崩溃后过期重派。

## 理由

- Prisma 迁移体系成熟，双端共享表结构单点化演进。
- MySQL 生产 + SQLite 开发保留零依赖自托管路径。
- Go 侧只读模型用 sqlx 足够，避免双 ORM 漂移。

## 备选（否决 / 搁置）

- Drizzle ORM：前期文档建议，用户先选 Prisma；**现为 Prisma + Bun 不兼容时的指定备选**（2026-09-17 用户决策）。
- EdgeOne Pages D1 / KV 作为主库：分发端 Cloud Functions 无法访问 Edge KV，管理端写路径不匹配 —— 仅边缘加速场景再评估。
- PostgreSQL：功能强，但用户给定的选项为 MySQL / SQLite —— 搁置。

## 后果与风险

- **Prisma + Bun 兼容性为 P1 验证项**；若不兼容，**更换 ORM（倾向 Drizzle，此前已评估），运行时坚持 Bun**（用户决策 2026-09-17）。schema 真相源与双方言策略不变，仅替换客户端层。
- Prisma 双 provider 的迁移文件不互通：以 MySQL 迁移为准绳，SQLite 开发库用 `db push` 同步。
- `Json` 字段在 SQLite 下为 TEXT，检索能力弱于 MySQL JSON 函数 —— 自定义元数据的复杂过滤 v1 以应用层为主（open-questions）。
- 分开部署（ADR-0011）下两应用对同一 schema 演进：迁移仅由 `packages/db` 执行且必须向后兼容（expand-contract，先加后删）；分发端使用独立受限 DB 账号（约定表只读 + `playback_sessions` 读写）。
- SQLite 与「跨机器分开部署」互斥：仅限单机自托管同卷共享；跨机 / 云函数部署必须 MySQL（ADR-0011 约束 3）。
- 2026-10-17：Go 分发端已支持 SQLite（`modernc.org/sqlite`，单机同卷形态），并按 Prisma 的物理存储对齐时间 / 布尔类型；三端可共用一个 `DATABASE_URL`，详见 ADR-0011 修订。
- **2026-11-13：ORM 长远目标改为 Drizzle（用户决策：更轻量、更适合 serverless）。迁移方案、准入门槛与不变量见 ADR-0020；在迁移动工前，本文的 Prisma 决策继续有效。**
