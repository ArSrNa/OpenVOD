# ADR-0020：Prisma 升到 7.10.1（驱动适配器 + 精确版本锁定）

- 状态：已接受（2026-11-14 用户决策：升 7.10.1 并锁版本）
- 日期：2026-11-14
- 关联：ADR-0004（数据库与 ORM，Prisma 决策本身不变）、ADR-0011（部署拓扑与 SQLite 物理表示）、ADR-0013（admin Next.js + better-auth）、ADR-0003（镜像与部署）

## 背景

1. ADR-0004 定 Prisma 为 schema 唯一真相源，MySQL / SQLite 两份 schema 人工同步 + parity 门禁。
2. 6.19.3 的 Rust 查询引擎带来三项实际成本：admin 镜像两个阶段都要装 openssl 才能让引擎选对 libssl；引擎二进制进入镜像；查询层与 TypeScript 类型分属两套生成物。
3. Prisma 8 目前是 `8.0.0-rc.33`（npm `latest` 标签），且数据库支持矩阵里 **MySQL 是 Early Preview**（迁移只支持建删表 / 列 / 索引 / 唯一约束 / 外键）、**SQLite 是 Experimental**（DateTime 以文本存储，与 Go 侧整数毫秒冲突）；schema 文件也换成新的 contract 格式。对本仓库不可用。

## 决策

1. `prisma` / `@prisma/client` 锁 **7.10.1**（精确版本，不带 `^`；8 GA 且 MySQL / SQLite 转正前不跟 `latest`）。
2. 驱动适配器（Prisma 7 对所有 SQL 库强制要求）：
   - MySQL → `@prisma/adapter-mariadb`，连接串直接吃 `mysql://`，schema provider 仍写 `"mysql"`；
   - SQLite → `@prisma/adapter-libsql`，admin（Node 22）与 worker（Bun）共用一份。实测 Bun 下 `better-sqlite3` 走 gyp 编译失败，官方也建议 Bun 用 libsql。
3. schema 的 `datasource` 去掉 `url`，连接串移到 `packages/db/prisma.config.ts`；generator 从 `prisma-client-js` 换成 `prisma-client`，`output` 由 `generated/mysql` / `generated/sqlite` 指定，导入路径变为 `.../generated/<方言>/client`。
4. 不变量（与 ADR-0004 / ADR-0011 一致，Go 侧完全不受影响）：
   - SQLite 的 DateTime 仍是**整数毫秒**：适配器构造写死 `{ timestampFormat: "unixepoch-ms" }`（Prisma 7 适配器默认是 ISO 8601 文本，不传就是静默数据错位）；
   - `file:./dev.db` 仍以 `packages/db/prisma` 为基准解析（`sqliteFileUrl` 与 Go `resolveSQLitePath` 同规则，从 CWD 向上找 schema 目录）；
   - 物理 schema、迁移历史、Go 只读模型、`task db:parity` 门禁均不变。
5. CLI 侧：`db push` / `migrate dev` 不再自动 generate，`--skip-generate` 已移除；`migrate diff` 的 `--from-url` 改 `--from-config-datasource`，`--to-schema-datamodel` 改 `--to-schema`，`db execute` 不再接受 `--schema`。相关脚本与 dev-workflow §4.3 已同步。

## 验证（2026-11-14 实测）

- `task db:generate` 两份客户端生成正常；`next build` 通过（TS2589 未复现，`getDb()` 的构造擦除仍保留作兜底）。
- MySQL：`PrismaMariaDb` 直接吃 `mysql://` 连接串，`SELECT 1` 与 `media.count()` 正常；`prisma migrate status` 显示 17 个迁移已应用。
- SQLite：`PRAGMA foreign_keys` = 1（删媒资级联清字幕正常）；`created_at` 物理类型为 `integer`，读回 Date。
- `bun test` 539 项全过；`go -C apps/delivery test ./...` 全过；`task db:parity` 通过。
- admin 镜像构建与运行阶段均移除 openssl（`ca-certificates` 保留）。

## 后果与风险

- 连接池与 TLS 参数改为底层驱动语义：TDSQL-C 上首次连生产库要确认 `ssl` 相关参数的写法（不再是 v6 引擎的那套）。
- `new PrismaClient()` 必须带 `adapter`：测试或脚本里自建客户端走 `@openvod/db` 导出的 `createSQLiteAdapter()`，保证时间戳格式只有一处定义。
- 客户端改为 ESM-only：admin（Next 16）与 worker（Bun）已验证；将来若有 CJS 消费者，需在 generator 里设 `moduleFormat`。
- 单例在多个测试文件共享同一进程时会串味（先绑到 mysql 的客户端被后续 sqlite 用例复用）：新增 `resetDb()` 供测试在设好 env 后重建。
- **构造即读 `DATABASE_URL`**（2026-11-15 实测）：v6 的 `new PrismaClient()` 缺 URL 也能构造（连接时才用），v7 的 adapter 在构造时就抛
  `DATABASE_URL 未配置`。admin 多个 lib 在模块顶层 `const db = getDb()`，`next build` 的 collect page data 会 import 它们 →
  没有 env 的构建环境（Docker）直接失败。镜像里以占位值构建（见 deploy-apps.md「待办与待验证」），
  新代码不要在模块顶层取 `getDb()`，用 `const db = () => getDb<any>()`（`lib/users.ts` / `lib/subtitles.ts` 即此写法）。
- Prisma 8 转正后需重新评估一次（MySQL / SQLite 状态、contract 格式迁移成本），另开 ADR。
