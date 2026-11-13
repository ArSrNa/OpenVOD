# ADR-0020：ORM 长远目标迁至 Drizzle（未来计划，暂不执行）

- 状态：提议（2026-11-13 用户决策方向：**未来全部换 Drizzle**；前置条件未触发，当前不执行，执行时另开提交并把本文状态改为「已接受」）
- 日期：2026-11-13
- 关联：ADR-0004（数据库与 ORM，迁移完成前仍然有效）、ADR-0008（转码流水线）、ADR-0011（部署拓扑）、ADR-0013（admin Next.js + better-auth）、ADR-0017（worker 双模式与 serverless 适配）、ADR-0003（serverless 部署目标）

## 背景

1. **现状（ADR-0004）**：`packages/db` 以 Prisma 为 schema 唯一真相源，两份 prisma schema（`schema.mysql.prisma` / `schema.sqlite.prisma`，各 427 行）人工同步 + 文本 parity 门禁；TS 侧仅 admin 与 worker 消费，Go 分发端用 `database/sql + sqlx` 只读。
2. **2026-11-13 用户方向**：ORM 长远改为 **Drizzle**，理由是「更轻量、更适合 Serverless」。ADR-0004 本就写明 Drizzle 是 Prisma 出问题时的指定备选，本文把它从「应急备选」升级为「长期目标」，同时给出可执行的分阶段迁移方案与准入门槛，避免半途而废。
3. **Serverless 收益的真实边界（必须先讲清，否则容易高估这件事）**：
   - 分发端（唯一的纯 serverless 组件，EdgeOne Functions）是 Go + sqlx，**换 TS ORM 对它零影响**；
   - admin 是常驻 Node 容器（ADR-0013），冷启动不是问题；
   - worker 有 `http` / `invoked` 模式跑在 serverless（ADR-0017），是当前唯一跑在 serverless 上的 JS 端。Prisma 在这里的额外成本是 Rust 查询引擎（镜像体积、每次实例启动加载引擎），但 ADR-0017 §5 已记录冷启动主体是镜像拉取 + ffmpeg，量级 10~60s，引擎加载只占其中几百 ms；
   - 因而本次迁移**不是**为了解决当下痛点，而是为「admin 未来可能迁 Edge 运行时 / 用 HTTP driver 直连 DB」「worker 生命周期进一步缩短」预留空间，并顺带清掉一套 codegen 工具链。**结论：收益真实但有限，属于长期对齐，不急。**
4. **Prisma 当前的实证痛点（迁移能真正消除的部分）**：
   - 两份生成客户端静态导入导致 TS2589，`packages/db/src/index.ts` 用 `as unknown as new () => unknown` 绕过；
   - `task db:generate` 是构建/测试前置，缺任一份即 `Module not found`；
   - admin 镜像构建阶段必须装 openssl 让 Prisma 选中匹配的 libssl 引擎（`apps/admin/Dockerfile` 顶部注释即此坑）；
   - `String` 默认映射 `VARCHAR(191)`，超长触发 P2000 让失败状态写不进库（`apps/worker/src/job-store.ts` 注释）；
   - better-auth 的 `prismaAdapter` 与两份客户端联合推断冲突，只能 `as any`。
5. **现状规模（迁移成本的地基，实测）**：16 model / 9 enum；查询调用点 163 处、18 个文件；事务 6 处（含 `settings-editor.ts` 的 Serializable 交互式事务、3 处数组批量）；Prisma 专有 API 面很窄——**无 `include`、无嵌套写、无 aggregate**，仅 `groupBy`×3、`upsert`、`updateMany`、`$queryRaw SELECT 1`；MySQL 迁移历史 17 个 / 396 行 SQL。

## 决策

### 1. 目标状态

- TS 侧（admin + worker）ORM 统一为 Drizzle；`packages/db` 继续是 schema 真相源，但内容从 prisma 文件变为 **TS 模型定义 + 两个方言 schema**（`mysql-core` / `sqlite-core`）。
- Prisma（`prisma` CLI、`@prisma/client`、两份生成客户端、`ts2589` 补丁、Dockerfile 的 openssl-for-engine 说明）在收尾阶段整体删除。
- **不变量（迁移前后完全不变）**：
  - 物理 schema：表名 / 列名（snake_case）/ 索引 / 外键 `ON DELETE` 语义 / 枚举以 TEXT 存储 / SQLite 时间戳为**整数毫秒** / 布尔为 0/1 —— Go 侧 `store.Time` 与 sqlx 读模型按此对齐（ADR-0011 修订），换 ORM 不得改变物理表示；
  - ID 形状：`packages/shared/src/index.ts` 用「`c` + 20 位以上小写字母数字」做路径注入白名单与「模板产物目录 vs 旧布局目录」判别，ID 生成器必须保持该形状；
  - 分发端仍是 Go + sqlx，本 ADR 不涉及；
  - 迁移仍由 `packages/db` 单点执行，expand-contract 向后兼容纪律不变。

### 2. 前置条件（不满足就不开工）

同时满足才启动迁移，否则维持 Prisma：

1. 有明确的 serverless 形态收益可验收：admin 迁 Edge 运行时，或 worker 实例生命周期缩短到「引擎加载时间占比 >10%」；
2. Prisma 7（`prisma-client` generator + driver adapter）迁移被实测否定，或该路线无法消除上面的实证痛点；
3. 有一个完整迭代周期（约 2 周）用于迁移 + 试用环境浸泡，不与功能开发并行。

### 3. 阶段划分（每阶段可独立回滚）

- **P0 准备（不动生产）**：
  - 在 TS 里写一份**中立模型描述**（表 / 列 / 类型 / 默认值 / 关系 / 索引），由它分别发射 `mysql` 与 `sqlite` 两套 drizzle schema —— 顺带替换现文本 parity 门禁（现门禁只能证明两文件文字一致，证明不了语义一致）；
  - 漂移门禁改造：用 `drizzle-kit pull` 从「Prisma 迁移建出来的库」introspect，与手写 schema 做零差异断言（具体命令与输出可比性需实测确认）；
  - driver 选型落定并写进实现记录：MySQL 用 `mysql2`；SQLite 同一份代码要同时跑在 Node（admin）与 Bun（worker）两个运行时，`better-sqlite3` 与 `bun:sqlite` 不可通用，优先验证 `@libsql/client` + `file:` URL 能否同时覆盖两者（**未验证，属开工第一件事**）。
- **P1 worker 对切**：`apps/worker/src/{job-store,media-store,media-key-store,settings}.ts` 四个文件先换（调用面最小，且有 `key-landing.test.ts` 的真实事务用例兜底）。
- **P2 admin 读写**：按模块推进，先纯查询（`media` / `categories` / `stats` / `watermarks` / `templates`），后事务密集（`settings` / `settings-editor` / `subtitles` / `keys` / `transcode`）；`groupBy`、`upsert`、`updateMany` 语义逐一对照验证。
- **P3 better-auth**：`prismaAdapter` → `@better-auth/drizzle-adapter`（1.7.5 已内置），modelName / 字段名映射与 `camelCase → snake_case` 配置需逐项核对；此步单独提交，便于回滚。
- **P4 收尾**：删除 prisma 依赖与生成物、迁移基线移交 drizzle-kit、`task db:generate` 从 Taskfile / Dockerfile / CI 移除、更新 ADR-0004 状态与 dev-workflow 排错条目。

**迁移权属纪律**：P0~P3 期间**schema 变更仍由 Prisma 迁移执行**（drizzle 只读、跟随），到 P4 才把迁移权属交给 drizzle-kit 并做一次 baseline（生成初始迁移 → 在试用库逐列比对 → 生产只插入 baseline 记录，不重放 SQL）。

### 4. 完成判据（DoD）

- `task test` 全绿，含两个真实 SQLite 用例（`apps/admin/test/settings.test.ts`、`apps/worker/test/key-landing.test.ts`）；
- Go 侧集成测试在 drizzle 建的库上通过（`apps/delivery/internal/store/store_sqlite_test.go` 等）；
- 试用环境跑通一条完整链路：上传 → 转码（含水印）→ 播放 → 密钥 → 字幕 → 删媒资级联；
- 有数据支撑的对比记录：admin / worker 镜像体积、worker `invoked` 模式首次可认领时间、`next build` 与 `bun test` 时长；
- Prisma 相关文件与依赖全部移除，仓库内无残留引用（含 `apps/delivery/internal/config/config.go` 里靠 `schema.sqlite.prisma` 定位仓库根的 `findPrismaSchemaDir()`，需改为别的锚点）。

## 理由

- 目标方向与仓库既有决策一致：ADR-0004 早已把 Drizzle 列为指定备选，本文只是把「应急」明确成「长期」。
- 现有 Prisma 使用面窄（无关系加载、无嵌套写、无聚合），**迁移是机械搬运而非架构重构**，主要风险不在 163 个调用点，而在物理 schema 语义对齐。
- 提前把「物理表示不变」写成硬约束，可以让 Go 侧完全不受影响 —— 这是本方案能低风险推进的关键。
- 分阶段 + 迁移权属留在 Prisma 到最后一刻，保证任一阶段都能单独回滚到一个可工作状态。

## 备选（否决 / 搁置）

- **Prisma 7 迁移（保留 Prisma，换 `prisma-client` generator + driver adapter）**：同样能去掉 Rust 引擎与双生成物冲突，成本低一个数量级 —— **作为先于本 ADR 的优先选项**，若它已消除 §背景 4 的痛点且满足 serverless 诉求，本 ADR 可长期挂起甚至关闭。
- **运行时双 ORM 灰度（按模块开关）**：两套 schema / 两套迁移同时存活，漂移风险与心智成本高于收益 —— 否决。
- **直接换成 kysely / 手写 SQL 仓储层**：better-auth 有 kysely adapter，且能彻底摆脱 ORM 绑定；但类型推导与迁移工具链要另配 —— 搁置，若 Drizzle 迁移遇阻再评估。
- **接管 Go 侧（引入 Go ORM 统一）**：违背 ADR-0004 的「Go 只用 sqlx 只读模型」，分发端在 serverless 上的二进制体积与冷启动更敏感 —— 否决。

## 后果与风险

- **SQLite 三个静默坑**（错一个都是数据问题，不是编译错误）：
  1. 时间戳必须显式 `integer({ mode: "timestamp_ms" })`，写成秒即与 Go `store.Time` 差 1000 倍；
  2. 外键级联需要每个连接 `PRAGMA foreign_keys = ON`，drizzle 不会自动开；漏了则删媒资不再级联清 `media_subtitles` / `transcode_jobs` / `hls_keys`，表现为静默残留；
  3. 枚举、JSON 列在 sqlite 下的存储形态（TEXT）必须与 Prisma 一致，否则已有开发库与 Go 读模型同时失真。
- **`@updatedAt` / `ON UPDATE CASCADE` 需手写**：Prisma 自动生成，drizzle 要在列定义与 `references({ onUpdate })` 里显式声明，漏写在 MySQL 上表现为时间戳不更新、外键不跟随更新。
- **Serializable 隔离级别**：`settings-editor.ts` 依赖 Serializable 交互式事务，drizzle 的 MySQL 事务需按驱动能力配置（sqlite 侧本身串行），语义需重新验证，不能只看编译通过。
- **`VARCHAR(191)` 反转为显式长度声明**：这是收益（不再有 P2000 意外），但每列都要写长度，漏写会落到数据库默认值，需在 P0 的模型描述里统一约定。
- **parity 门禁重建期是风险窗口**：P0 期间新旧两套门禁并存，务必保持旧门禁（文本 diff）可用直到 P1 开始。
- **一次不可回滚的操作只有 P4 的迁移权属移交**：baseline 前必须在试用库上完整演练一遍，且保留 Prisma 迁移历史目录一个发布周期。
- **收益兑现依赖后续演进**：若 admin 最终仍留在 Node 容器、worker 仍是长生命周期实例，本次迁移的 serverless 收益接近于零，只剩「工具链变轻」—— 这也是 §2 前置条件列在最前的原因。
