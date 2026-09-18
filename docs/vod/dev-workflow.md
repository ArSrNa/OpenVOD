# 开发环境与工作流（Dev Workflow）

日常开发路径：准备 → 启动 → 数据库 → 建号联调 → 排错。决策背景见
[ADR-0001](./decisions/0001-monorepo-structure.md)（Monorepo）、[ADR-0004](./decisions/0004-database-and-orm.md)（Prisma 双方言）、
[ADR-0008](./decisions/0008-transcoding-pipeline.md)（Worker）、[ADR-0013](./decisions/0013-admin-nextjs-betterauth.md)（Next.js 全栈管理端）。

## 1. 组件与端口

| 组件 | 目录 | 运行时 | 端口 / 探测 | 说明 |
|---|---|---|---|---|
| 管理端 admin（UI + API） | `apps/admin` | Node（`next dev` / `next start`） | `:8787` · `GET /healthz` | UI/API 同源，无 CORS（ADR-0013） |
| 分发端 delivery | `apps/delivery` | Go（Chi） | `:9000` · `GET /healthz` | 播放热路径（ADR-0010） |
| 转码 Worker | `apps/worker` | Bun（常驻） | 无端口（轮询） | 需 `ffmpeg` / `ffprobe`（ADR-0008）；`./start.sh` 已一并启动，**不启动则转码任务停在「排队中」** |
| 共享包 | `packages/{db,shared,crypto,storage,transcode,contracts}` | TS 源码直引 | — | Next 经 `transpilePackages` 转译 |

## 2. 前置工具链

| 依赖 | 用途 | 说明 |
|---|---|---|
| Bun ≥ 1.4 | 依赖安装、Worker、脚本 | `bun i`（workspace） |
| Go 1.26 | 分发端 / 契约代码生成 | `go -C apps/delivery run .` |
| ffmpeg + ffprobe | Worker 必需 | 缺失时 `task dev:worker` 直接退出 |
| Node 22+ | Next.js 运行时 | 由 `bun run --cwd apps/admin dev` 拉起 |
| Task | 任务编排（可选） | 无 Task 时看 `Taskfile.yml` 里的原始命令 |
| Docker | 镜像构建 / 生产形态（可选） | `.ide/Dockerfile` |

云原生开发容器已内置上述工具（`.cnb.yml` → `docker.cnb.cool/arsrna/media/openvod/dev:latest`）。

## 3. 首次准备

```bash
bun i                     # 安装 workspace 依赖
sh scripts/gen-env.sh     # 生成根 .env（已存在则跳过；--force 覆盖）
task db:generate          # 生成 Prisma 客户端（mysql + sqlite 两份）
task db:push              # SQLite 开发库建表（DB_PROVIDER=sqlite 时）
task contracts            # zod → JSON Schema → Go struct（生成物入库）
task vectors              # TS/Go 加密互通测试向量
```

`.env` 的来源与密钥仓库机制见根 [README](../../README.md#环境变量与-envscriptsgen-envsh)；
无密钥仓库时可用 `cp .env.example .env` 兜底（占位密钥仅够跑通启动）。

> 云原生开发容器会把根 `.env` 写入 `~/.bashrc`（`set -a; . .env; set +a`），新终端自动带上变量。
> 本机开发需自行 source：`set -a; . ./.env; set +a`，或统一走下面的启动脚本。

## 4. 数据库（ADR-0004：MySQL 为准绳，SQLite 供本地开发）

### 4.1 两份 Prisma 客户端必须同时存在（高频坑）

`packages/db/src/index.ts` 为便于打包，**静态导入**两份客户端，仅按 `DB_PROVIDER` 实例化其一：

```ts
import { PrismaClient as MySQLPrismaClient } from "../generated/mysql";
import { PrismaClient as SQLitePrismaClient } from "../generated/sqlite";
```

因此 `generated/mysql` 与 `generated/sqlite` 缺一不可，否则 Next/webpack 报
`Module not found: Can't resolve '../generated/sqlite'`。生成物在 `packages/db/generated/`（`.gitignore` 已忽略），**改 schema 后必须重新生成**：

```bash
task db:generate          # = generate:mysql + generate:sqlite
```

### 4.2 SQLite（本地开发推荐）

```env
DB_PROVIDER="sqlite"
DATABASE_URL="file:./dev.db"    # 相对 packages/db/prisma/ → packages/db/prisma/dev.db
```

```bash
task db:generate
task db:push              # 按 schema 建表（SQLite 无迁移历史，直接 push）
bun run --cwd packages/db studio    # 可选：Prisma Studio 查看数据
```

### 4.3 MySQL（共享库 / TDSQL-C）

```env
DB_PROVIDER="mysql"
DATABASE_URL="mysql://user:pwd@host:3306/openvod"
```

```bash
task db:generate
task db:migrate           # prisma migrate deploy：应用 prisma/migrations/ 下的迁移
task db:parity            # 校验两份 schema 的 enum/model 段逐字一致（CI 门禁）
```

**要给一个空库首次建表**：`prisma migrate dev` 会创建影子库（shadow database），
TDSQL-C / 云数据库上的业务账号通常没有 `CREATE DATABASE` 权限，会报 `P3014`。
此时用 Prisma 官方 baseline 流程（一次性，之后 `task db:migrate` 正常增量应用）：

```bash
cd packages/db
mkdir -p prisma/migrations/20260918000000_init
# 1) 由 schema 生成初始迁移 SQL（不连库）
./node_modules/.bin/prisma migrate diff \
  --from-empty --to-schema-datamodel prisma/schema.mysql.prisma \
  --script > prisma/migrations/20260918000000_init/migration.sql
# 2) 把 SQL 直接执行到目标库
./node_modules/.bin/prisma db execute \
  --file prisma/migrations/20260918000000_init/migration.sql \
  --schema prisma/schema.mysql.prisma
# 3) 登记为「已应用」，避免 migrate deploy 重复执行
./node_modules/.bin/prisma migrate resolve \
  --applied 20260918000000_init --schema prisma/schema.mysql.prisma
# 4) 校验库结构与 schema 一致（输出 "-- This is an empty migration." 即无漂移）
./node_modules/.bin/prisma migrate diff \
  --from-url "$DATABASE_URL" --to-schema-datamodel prisma/schema.mysql.prisma --script
```

> 上述命令需先加载 `.env`：`set -a; . ./.env; set +a`。
> 之后改模型：本地 `prisma migrate dev`（有影子库权限时）生成迁移文件并入库，CI/生产只跑 `migrate deploy`。

## 5. 启动

### 5.1 一键（后台运行）

```bash
./start.sh                              # 启动 admin + delivery + worker（已在运行则跳过）
./start.sh status                       # 运行状态（含 worker）
./start.sh logs worker                  # 跟踪日志（admin | delivery | worker）
./start.sh stop                         # 停止
```

- 日志与 pid 在 `.run/`（已忽略）；启动前自动补依赖与 Prisma 生成物（两份客户端）。
- 探测方式：`curl -fsS http://localhost:8787/healthz`、`http://localhost:9000/healthz`；**worker 无 HTTP 端口，存活判定用 `.run/worker.pid`**。
- ⚠️ **worker 是转码队列的唯一消费者**：只起 admin 而不起 worker 时，管理端发起的任务会一直停在「排队中」（`transcode_jobs.attempts=0`、`lease_until` 为空即"从未被认领"）。

### 5.2 单服务前台（调试用）

| 命令 | 服务 | 说明 |
|---|---|---|
| `./start-admin.sh` | 管理端 `:8787` | 前台，`next dev`；自动加载根 `.env`、补依赖与生成物。**并会自动后台启动 Worker**（日志 `.run/worker.log`），脚本退出（含 Ctrl-C）时一并停掉；若已有 Worker 在跑则沿用、退出时不动它 |
| `./start-delivery.sh` | 分发端 `:9000` | 前台；每次增量 `go build` 到 `.run/delivery` |
| `./start-worker.sh` | Worker | 前台单跑（观察认领 / 转码日志）；需 `ffmpeg`/`ffprobe` |
| `task dev:admin` | 管理端 `:8787` | 同 `start-admin.sh`（含 `.env` 注入）；**注意：此路径不自动起 Worker**，转码需另开 `task dev:worker` |
| `task dev:delivery` | 分发端 `:9000` | `go run .`（含 `.env` 注入） |
| `task dev:worker` | Worker | `bun --watch`，需 `ffmpeg`/`ffprobe` |

> 启动脚本都会先加载根 `.env`。直接 `bun run --cwd apps/admin dev` 会缺少
> `BETTER_AUTH_SECRET` / `DATABASE_URL`（Next 只读 `apps/admin/.env`，该文件默认不存在）。

访问：管理端 <http://localhost:8787>（未登录会 307 到 `/login`）；分发端健康检查 <http://localhost:9000/healthz>。

## 6. 创建本地管理员账号（ADR-0012 双轨 / ADR-0013）

```bash
bun apps/admin/scripts/create-admin.ts <email> <password≥8位> [名称]
```

示例：`bun apps/admin/scripts/create-admin.ts root@example.com 'Passw0rd!' "Root"` → 用该账号在 `/login` 登录。

前置：目标库已建表（§4.2 / §4.3），否则报 `P2021 The table admin_users does not exist`；
OIDC 登录需在 `.env` 配置 `OIDC_ISSUER` / `OIDC_CLIENT_ID` / `OIDC_CLIENT_SECRET`（不配则仅本地邮箱密码登录）。

## 7. 测试与构建

```bash
task test                 # bun test + go -C apps/delivery test ./...
task build:admin          # 管理端生产构建（需先 task db:generate）
task build:delivery       # 分发端二进制 → apps/delivery/bin/delivery
task image:delivery       # 分发端镜像（SCF 仅 x86，显式 --platform linux/amd64）
task contracts            # 契约生成物变更后需入库（契约门禁）
```

## 8. 排错速查

| 现象 | 原因 / 处理 |
|---|---|
| `Module not found: Can't resolve '../generated/sqlite'`（或 mysql） | 只生成了一份客户端；`task db:generate` 生成两份，然后重启 dev |
| `P2021 The table xxx does not exist` | 目标库未建表；SQLite 用 `task db:push`，MySQL 用 §4.3 迁移/baseline |
| `P3014 could not create the shadow database` | 账号无建库权限；按 §4.3 的 baseline 四步，不要用 `migrate dev` |
| 登录 403 + `[Better Auth]: Invalid origin: http://xxx` | CNB 预览网关转发时会把请求头 `Origin` 改写成 `http://<目标域名>`（实测：任意 Origin 都被改写，与浏览器是否用 https 无关）。`auth.ts` 已把 `ADMIN_BASE_URL` 的 http 等同体加进 `trustedOrigins`；仍报错时核对 `ADMIN_BASE_URL` 的 host 是否就是访问域名（CNB 上若注入了 `CNB_VSCODE_PROXY_URI`，`auth.ts` 已自动按 `{{port}} → ADMIN_PORT` 覆盖，无需手填）。附：better-auth 对无通配符条目做全量相等比对，`ADMIN_TRUSTED_ORIGINS` 里裸域名会被展开为 http/https 两条 |
| 分发端启动即退出，提示 `URL_SIGN_KEY_HEX 未配置` / `MASTER_KEYS 未配置` | 未加载 `.env`；改用 `./start-delivery.sh` 或 `task dev:delivery` |
| `[worker] 缺少必需工具：ffmpeg, ffprobe` | 装 ffmpeg（`.ide/Dockerfile` 镜像已含） |
| 运行时报 `Cannot find module '@openvod/xxx'`（某 app 里） | **该 app 的 `package.json` 没声明这个 workspace 依赖**：bun 只给声明了依赖的包建软链，缺声明时从该包内解析不到（`packages/*` 之间同理）。补 `"@openvod/xxx": "workspace:*"` 后 `bun i`。已在 `packages/crypto`（→ shared）与 `apps/worker`（→ contracts）踩到过 |
| 管理端 `Error: [safe-delete]...SAFE_DELETE_BULK_CONFIRM_REQUIRED`（构建时） | Next 清理 `.next/turbopack` 触发环境的批量删除保护；先 `rm -rf apps/admin/.next` 再 `task build:admin` |
| 任务一直停在「排队中」 | **worker 没在跑**（最常见）：`./start.sh status` 看 worker 行；起起来用 `./start.sh`（含 worker）或 `task dev:worker`。判据：该行 `attempts=0` 且 `lease_until` 为空 = 从未被任何消费者认领。若两者都非空，则是上一实例仍在执行或 lease 未过期（`WORKER_LEASE_MS`）|
| 任务反复失败 / `last_error` 提到「重试次数已达上限」 | Worker 崩溃循环；看 `last_error` 根因（常见：`MASTER_KEYS 不可用`、源片缺失、模板档位全部被跳过）。修好后在「转码任务」页重新发起 |
| Worker 停不掉 / 有看不见的残留消费者 | `bun --watch` 会吞 SIGTERM，必须整组 SIGKILL：用 `./start.sh stop`（按 `.run/worker.pid` 对进程组收尾）。若启动脚本曾被 `\| head`/`\| grep` 之类管道提前中断（SIGPIPE 会跳过退出清理），pid 文件仍在，`./start.sh stop` 照样能收掉 |
| 管理端 `Fast Refresh had to perform a full reload due to a runtime error` | 通常是上面某类运行时错误的连带表现，先按上表修根因，再重启 `./start-admin.sh` |
| 端口被占 / `已是运行状态` | `./start.sh status` 查看，`./start.sh stop` 停止；或换 `ADMIN_PORT` / `DELIVERY_LISTEN` |
| `bun run --cwd packages/db exec ...` 报 `Script not found "exec"` | 用 `cd packages/db && ./node_modules/.bin/prisma ...` |

## 9. 目录与忽略规则

| 路径 | 说明 |
|---|---|
| `.env` | 本地密钥，不入库（真源在 CNB 密钥仓库） |
| `.run/` | `start.sh` 的 pid / 日志 / delivery 二进制 |
| `packages/db/generated/` | Prisma 生成物（按方言，不入库） |
| `packages/db/prisma/*.db` | SQLite 开发库文件 |
| `packages/contracts/jsonschema/`、`apps/delivery/internal/contracts/` | 契约生成物，**需要入库** |
