# 开发环境与工作流（Dev Workflow）

日常开发路径：准备（AI Agent 必须先走 §3.0 强制询问）→ 启动 → 数据库 → 建号联调 → 排错。决策背景见
[ADR-0001](./decisions/0001-monorepo-structure.md)（Monorepo）、[ADR-0004](./decisions/0004-database-and-orm.md)（Prisma 双方言）、
[ADR-0008](./decisions/0008-transcoding-pipeline.md)（Worker）、[ADR-0013](./decisions/0013-admin-nextjs-betterauth.md)（Next.js 全栈管理端）。

## 1. 组件与端口

| 组件 | 目录 | 运行时 | 端口 / 探测 | 说明 |
|---|---|---|---|---|
| 管理端 admin（UI + API） | `apps/admin` | Node（`next dev` / `next start`） | `:8787` · `GET /healthz` | UI/API 同源，无 CORS（ADR-0013）；端口由 `ADMIN_PORT` 控制 |
| 分发端 delivery | `apps/delivery` | Go（Chi） | `:9000` · `GET /healthz` | 播放热路径（ADR-0010）；端口由 `DELIVERY_LISTEN` 控制 |
| 转码 Worker | `apps/worker` | Bun（常驻） | 无端口（轮询） | 需 `ffmpeg` / `ffprobe`（ADR-0008）；`bun scripts/dev.ts` 已一并启动，**不启动则转码任务停在「排队中」** |
| 播放演示 App player | `apps/player` | Node（`next dev` / `next start`） | `:3100` · `GET /healthz` | 播放端 Web 参考实现（spec.md §11）；免登录（预览账号服务端换 JWT），只消费分发端 `/v1` API；端口由 `PLAYER_PORT` 控制 |
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

### 3.0 强制询问：配置环境前必须向用户确认（AI Agent 必读，不得跳过）

**执行顺序**：接到「配置 / 准备开发环境」类请求 → 按【必问清单】一次性集中提问（附推荐项，避免挤牙膏式多轮追问）→ 等待用户逐条答复 → 按答复执行 §3.1 起的命令 → 完成后向用户汇报实际采用的选择。

- **必须询问，不得跳过**：Q1–Q5 未获明确答复前，不得执行任何有副作用的配置命令（`bun i`、版本检测等无副作用动作可先行）。**文档里的推荐默认不是跳过询问的理由**；仅当用户明确答复「按推荐来」时才允许采用下面的推荐默认表。用户说「随便 / 你看着办」不算授权，须复述推荐项并得到确认。
- **豁免与按需缩减**：`.env` 已存在且用户明确指示「沿用现有环境」时，跳过 Q1 / Q2，但仍须确认 Q3–Q5。只执行局部流程的请求只问对应问题：起服务 → Q3；建号 → Q4；调试播放链路 → Q5。
- **不问能自己检测的**：工具链版本、ffmpeg / ffprobe 是否安装、端口占用、依赖是否已装过——直接执行检测命令，异常时才提示用户，不要拿检测结果凑问题。
- **密钥不落对话**：不得要求用户把 `MASTER_KEYS` / `BETTER_AUTH_SECRET` 等密钥明文贴进对话；本地开发一律由 `gen-env.sh` 生成或用占位值。用户口头提供 MySQL 连接串时直接写入 `.env`，后续回显一律打码密码段。

#### 必问清单

| # | 问题 | 为什么必须问 | 答案去向 |
|---|---|---|---|
| Q1 | 数据库选 **SQLite**（本地开发推荐）还是 **MySQL**（共享库 / TDSQL-C）？选 MySQL 时需提供连接串 `mysql://user:pwd@host:3306/库名`，并说明该业务账号**是否有 `CREATE DATABASE` 权限** | 决定 `DB_PROVIDER` 与建表路径（`db:push` / `migrate` / §4.3 baseline 四步）；凭据只有用户知道 | §4.2 / §4.3 |
| Q2 | `.env` 密钥来源：① 已有真实密钥（CNB 密钥仓库 / 现成 `.env`）；② 没有，用占位密钥先跑通本地 | 密钥真源在密钥仓库，AI 无法自行获取；占位密钥仅够启动，不能联调真实存储 / 线上库 | §3.1 |
| Q3 | 要启动哪些服务（admin / delivery / worker 任意组合）、前台调试还是后台常驻？ | worker 是转码队列唯一消费者，起不起直接决定转码任务能否推进；运行方式影响终端占用与日志查看方式 | §5 |
| Q4 | 本地管理员账号用什么 email 与密码（≥8 位）？或暂不创建（将无法登录管理台） | 建号命令需要凭据参数，AI 不得擅自编造用户凭据 | §6 |
| Q5 | 是否本地调试播放链路（M3）？需要的话提供播放端用户名 / 密码，以及是否要管理端「产物 → 播放」预览账号 | 超出最小启动范围，涉及分发端联调与可选预览账号 | §5.3 |

#### 推荐默认（仅在用户答复「按推荐来」后采用）

| 问题 | 推荐值 |
|---|---|
| Q1 | SQLite：`DB_PROVIDER=sqlite` + `task db:push` |
| Q2 | 无密钥仓库时 `cp .env.example .env`（占位密钥，仅本地跑通） |
| Q3 | `bun scripts/dev.ts all --background`（admin 自动带起 worker） |
| Q4 | email 用 `admin@example.com`，密码由 AI 随机生成 ≥8 位并一次性告知，提醒首登后自改 |
| Q5 | 首次配置默认不启用；需要时 `bun apps/admin/scripts/bootstrap-playback.ts demo <密码≥8位>` |

#### 询问之后必须做的事

1. 把用户答复记录为环境决策（例：「SQLite + 占位密钥 + 后台全服务」），严格按对应章节执行，不得偏离；
2. 全部完成后汇报：实际采用的选择、已启动的服务与访问地址、下一步可做动作（建号 / 调试播放链路）；
3. 用户中途改主意（如 SQLite → MySQL）：按 §4 / §8 对应条目调整；改 `DB_PROVIDER` 后必须重跑 `task db:generate`（两份客户端缺一不可，见 §4.1）。

### 3.1 执行准备命令

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

> **容器形态（预构建镜像，常驻）**：`scripts/compose.sh up` 以 docker compose 常驻运行 admin + worker + player
> （镜像由流水线预构建；CNB 端口预览 / 挂载 / 公网 DB 连通已实测）。源码直跑（本节各命令）仍是日常
> 开发调试主路径；**两种形态不要同时起**（端口冲突）。详见 [deploy-apps.md](./deploy-apps.md) 的 Compose 运行章节。

### 5.1 一键（后台运行）

```bash
bun scripts/dev.ts                      # 交互式：勾选服务（admin / delivery / worker / player）+ 运行方式（前台调试 / 后台常驻）
bun scripts/dev.ts all --background     # 一键后台起 admin + delivery + worker + player（等价旧 ./start.sh）
bun scripts/dev.ts status               # 运行状态（含 worker / player）
bun scripts/dev.ts logs worker          # 跟踪日志（admin | delivery | worker | player；-n 行数 / --no-follow）
bun scripts/dev.ts stop                 # 停止（worker → player → delivery → admin；也可只停指定服务）
```

- 端口跟随根 `.env` 的 `ADMIN_PORT` / `DELIVERY_LISTEN` / `PLAYER_PORT`（缺省 `8787` / `:9000` / `3100`），健康探测与提示都按实际端口来。
- 日志与 pid 在 `.run/`（已忽略）；启动前自动补依赖与 Prisma 生成物（两份客户端）。
- 探测方式：`curl -fsS http://localhost:${ADMIN_PORT:-8787}/healthz`、`http://localhost:${DELIVERY_LISTEN#:}/healthz`；**worker 无 HTTP 端口，存活判定用 `.run/worker.pid`**。
- 后台服务用 `setsid` 起独立进程组，停止时整组收掉（`bun --watch` 吞 SIGTERM → TERM 宽限后 SIGKILL 兜底）。
- `worker` 用 `bun run start` 启动（**无 `--watch`**，2026-10-17 起）：Worker 串行消费转码任务，`--watch` 会在保存任何被 import 的文件时重启并**腰斩正在跑的 ffmpeg**（任务停在 ENCODING、lease 过期后被反复重认领，实测 9 个任务全部卡死）。开发 Worker 代码要热重载时用 `task dev:worker`（`bun --watch`，前台）。
- ⚠️ **worker 是转码队列的唯一消费者**：只起 admin 而不起 worker 时，管理端发起的任务会一直停在「排队中」（`transcode_jobs.attempts=0`、`lease_until` 为空即"从未被认领"）；启动 admin 会自动带起 worker（`--no-worker` 关闭）。

### 5.2 单服务前台（调试用）

| 命令 | 服务 | 说明 |
|---|---|---|
| `bun scripts/dev.ts admin` | 管理端（`ADMIN_PORT`） | 前台，`next dev`；自动加载根 `.env`、补依赖与生成物。**并会自动后台启动 Worker**（日志 `.run/worker.log`），退出（含 Ctrl-C）时一并停掉；若已有 Worker 在跑则沿用、退出时不动它 |
| `bun scripts/dev.ts delivery` | 分发端（`DELIVERY_LISTEN`） | 前台；每次增量 `go build` 到 `.run/delivery`；`DELIVERY_DATABASE_URL` 为本地占位时自动回退 `DATABASE_URL` |
| `bun scripts/dev.ts worker` | Worker | 前台单跑（观察认领 / 转码日志）；无 `--watch`（见 §5.1）；需 `ffmpeg`/`ffprobe` |
| `bun scripts/dev.ts player` | 播放演示 App（`PLAYER_PORT`） | 前台 `next dev`；免登录播放端 Demo（spec.md §11），播放依赖分发端与预览账号（`PLAYER_PREVIEW_*`，回退 `DELIVERY_PREVIEW_*`） |
| `task dev:admin` | 管理端（`ADMIN_PORT`） | `next dev` + `.env` 注入；**注意：此路径不自动起 Worker**，转码需另开 `task dev:worker` |
| `task dev:delivery` | 分发端（`DELIVERY_LISTEN`） | `go run .`（含 `.env` 注入） |
| `task dev:worker` | Worker | `bun --watch`（改 Worker 代码热重载用），需 `ffmpeg`/`ffprobe` |

### 5.3 播放链路本地调试（M3；规则见 spec.md §6）

```bash
# 1) 引导（幂等）：生成 JWT 签名密钥（入 signing_keys）+ 创建/重置播放端用户
bun apps/admin/scripts/bootstrap-playback.ts demo <密码≥8位>

# 2) 分发端：本地调试需把 DELIVERY_DATABASE_URL 指向可达库（.env 里是 127.0.0.1 占位，见 §8）
bun scripts/dev.ts delivery    # 启动器在该值为空/127.0.0.1/localhost 时自动回退用 DATABASE_URL（亦可直接改 .env）

# 3) login 取 JWT → play 取签名主清单 URL
TOKEN=$(curl -s -X POST localhost:9000/v1/auth/login -H 'content-type: application/json' \
  -d '{"username":"demo","password":"<密码>"}' | python3 -c 'import sys,json;print(json.load(sys.stdin)["access_token"])')
MF=$(curl -s -X POST localhost:9000/v1/media/<媒资id>/play -H "authorization: Bearer $TOKEN" -d '{}' \
  | python3 -c 'import sys,json;print(json.load(sys.stdin)["manifest_url"])')

# 4) 真播放器视角（自动取密钥 + 本地解密）
ffprobe "$MF" && ffmpeg -i "$MF" -c copy /tmp/out.mp4
```

- **管理端「产物 → 播放」预览**：在同一份 `.env` 里配置 `DELIVERY_BASE_URL`、`DELIVERY_PREVIEW_USERNAME`、`DELIVERY_PREVIEW_PASSWORD`（预览账号用 `bun apps/admin/scripts/bootstrap-playback.ts preview <密码>` 创建，建议专用）；管理端后端经**播放器 SDK**（`openvod-jssdk` password 模式，token 缓存与重登由 SDK 治理）以该账号换签名主清单 URL，浏览器用 hls.js 直连分发端播放（解密仍在浏览器本地）。未配置时预览接口返回 501，其余管理功能不受影响；
- 无 token 拉清单 / 取密钥 → 403 `bad_token`（P0 门禁语义）；密钥响应固定 16B + `no-store`；
- token 以 query `t` 为主（改写后的清单里已自动带上）；App / hls.js 也可用 header `X-Playback-Token`（Safari 原生只能 query）；
- 多套模板产物时 `play` 可带 `template_id`（不指定则取唯一产物或默认模板产物）；
- M3 未覆盖项（限频 / 严格模式 / sqlite 驱动）见 spec.md §6.6；CDN+TypeA 演进项已于 2026-09-20 关闭（S3 预签名直出定稿，ADR-0005 修订）。

> `bun scripts/dev.ts` 会先加载根 `.env`。直接 `bun run --cwd apps/admin dev` 会缺少
> `BETTER_AUTH_SECRET` / `DATABASE_URL`（Next 只读 `apps/admin/.env`，该文件默认不存在）。

访问：管理端 <http://localhost:${ADMIN_PORT:-8787}>（未登录会 307 到 `/login`）；分发端健康检查 <http://localhost:${DELIVERY_LISTEN#:}/healthz>。

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
| `The column xxx.yyy does not exist in the current database`（P2021 的列形态） | **改了 Prisma schema 但没把迁移应用到目标库**——生成客户端（`task db:generate`）只更新类型与查询引擎，**不会**改库。MySQL 跑 `task db:migrate`（= `prisma migrate deploy`），SQLite 跑 `task db:push`；先跑 `bunx prisma migrate status --schema prisma/schema.mysql.prisma`（只读）确认是「not yet been applied」还是 failed / drift。additive 迁移（加列 / 加表）向后兼容，放心补跑 |
| `P1012 the URL must start with file:`（跑 `task db:push` 时） | `.env` 的 `DATABASE_URL` 是 MySQL——`db:push` 只服务 SQLite 开发库；MySQL 用 `task db:migrate`。临时要 SQLite 库可内联覆盖：`DATABASE_URL="file:./dev.db" bun run --cwd packages/db push:sqlite` |
| `P3009 failed migrations` + MySQL `1064` near `'--…'` | 迁移 SQL 的 `--` 注释后**必须跟空格**（紧跟文字时 MySQL 不识别为注释，整个文件报 1064 且被记为 failed 挡住后续迁移）。修正 SQL 后：`bunx prisma migrate resolve --rolled-back <迁移名> --schema prisma/schema.mysql.prisma`，再 `task db:migrate` |
| `P3014 could not create the shadow database` | 账号无建库权限；按 §4.3 的 baseline 四步，不要用 `migrate dev` |
| 重转码后播放**还是旧画面 / 旧水印**（改水印或模板参数重转无效） | 配了 `STORAGE_CDN_BASE_URL` 时九成是 **CDN 缓存键忽略了查询串**：产物按模板树原位替换（路径不变），预签名 query 每次不同但缓存键相同 → CDN 一直回旧分片。验证：对比 CDN 响应头 `last-modified` 与任务完成时间（旧 = 命中陈旧缓存）；或无签名裸打分片 URL，返回 200 即坐实（顺带说明 URL 鉴权已被缓存绕过）。处理：EO 控制台**刷新缓存**（目录刷新 `proceed/`）先恢复，再把缓存键改为**含完整 query** 或启用 CDN URL 鉴权（spec §6.5；两模式控制台配置逐项清单见 deploy-delivery.md「CDN 加速域名与资产签名配置清单」） |
| 登录 403 + `[Better Auth]: Invalid origin: http://xxx` | CNB 预览网关转发时会把请求头 `Origin` 改写成 `http://<目标域名>`（实测：任意 Origin 都被改写，与浏览器是否用 https 无关）。`auth.ts` 已把 `ADMIN_BASE_URL` 的 http 等同体加进 `trustedOrigins`；仍报错时核对 `ADMIN_BASE_URL` 的 host 是否就是访问域名（CNB 上若注入了 `CNB_VSCODE_PROXY_URI`，`auth.ts` 已自动按 `{{port}} → ADMIN_PORT` 覆盖，无需手填）。附：better-auth 对无通配符条目做全量相等比对，`ADMIN_TRUSTED_ORIGINS` 里裸域名会被展开为 http/https 两条 |
| 分发端启动即退出，提示 `URL_SIGN_KEY_HEX 未配置` / `MASTER_KEYS 未配置` | 未加载 `.env`；改用 `bun scripts/dev.ts delivery` 或 `task dev:delivery` |
| 管理端向导页报 `MASTER_KEYS 未配置/非法`，但部署环境明明配了 | 该判定同时覆盖两种情况：①**运行进程 env 里没有**——配在构建期（CI/镜像构建参数）、只配了 worker 没配 admin、或改了 `.env` 后没重建容器（compose 必须 `up -d --force-recreate admin worker`，`restart` 不重读 env_file）；②**值格式非法**——带引号 / 含空白或换行 / 全角冒号「：」/ hex 不足 64 位（`openssl rand -hex 32`）。自查：启动日志 `[admin] MASTER_KEYS 自检失败：<原因>`（`bun scripts/dev.ts logs admin`）或 `docker compose exec admin printenv MASTER_KEYS \| cut -c1-12`（**只看前缀，别把密钥贴进聊天/日志**）；向导页也会直接显示原因。`.env` 侧另有 `sh scripts/gen-env.sh --check`，但它只查存在性与占位值，不校验格式 |
| 点「密钥管理」被弹回 `/setup`（即使已登录） | 服务端守卫先判向导再判会话（`apps/admin/src/lib/console.ts`）：`system_settings.setup_completed` 非 `1` → 跳 `/setup`（**说明该 admin 进程连的库里没有初始化标记**：向导没走完，或 `DATABASE_URL`/`DB_PROVIDER` 指到了另一个库）；读库抛错反而按“已完成”处理 → 跳 `/login` 而非 `/setup`。已在库中的初始化状态可用 `curl -s <admin>/api/setup` 判定：403「系统已完成初始化」= 正常 |
| 分发端启动报 `数据库连接失败: dial tcp 127.0.0.1:3306` | `.env` 的 `DELIVERY_DATABASE_URL` 是本地占位；`bun scripts/dev.ts delivery` 会自动回退用 `DATABASE_URL`（亦可手动 `DELIVERY_DATABASE_URL="$DATABASE_URL" bun scripts/dev.ts delivery`；生产必须用受限账号，ADR-0011） |
| `login` 返回 503「未配置 JWT 签名密钥」 | `signing_keys` 无 ACTIVE 的 JWT 行：`bun apps/admin/scripts/bootstrap-playback.ts <用户> <密码≥8位>` 后重启分发端 |
| player 报「无法连接分发端（"http://..."）」（值带引号）| `docker run --env-file` 不剥 .env 引号（compose 会剥）——player 已对 URL / 账号做剥离防御，仍报错说明是未覆盖的键；用不带引号的 `-e KEY=value` 覆盖或改用 compose。同类：`next start` 报 `'-p' ... not a non-negative number` = `PLAYER_PORT` 带引号（镜像 CMD 已清洗，自建命令需自行处理） |
| `play` 返回 409 `not_playable` | 媒资非 `READY`（转码中 / 失败）、该媒资无转码产物，或多套产物未指定 `template_id`（响应消息会列出可选值；模板 ID 亦可在管理端媒资详情查看） |
| EdgeOne 部署后管理端预览 404，`/healthz` 也返回 Makers HTML `NOT_FOUND` / `The site does not exist` | 请求未到达 delivery。旧构建把共享 Go 源码放入 `cloud-functions/`，CLI 将 `server.go` 识别为 Framework 入口并生成 `/server` 前缀；改用 `task build:edgeone` 构建独立暂存项目并校验根 catch-all，`bun --no-env-file scripts/edgeone.ts deploy` 上传受检查产物到生产环境。再用 `bun --no-env-file scripts/check-delivery-deployment.ts <分发域名>` 验收健康 JSON 与无签名 403；若仍是平台 HTML 404，核对 Makers 域名绑定和生产部署。验收通过后在管理端重新生成播放 URL，完整步骤见 [deploy-delivery.md](./deploy-delivery.md) |
| Makers 控制台已配置变量，但 Go 函数仍 502、日志报 `DELIVERY_DATABASE_URL 未配置` | Go Framework 上传产物未收到引导变量。使用更新后的 `scripts/edgeone.ts build` / `deploy`：发布前从控制台 Production 读取两项引导配置，写入私有函数包，由 EdgeOne 入口补齐进程环境。检查 `EO_API_REGION` 是否与账号站点一致；不要把 admin 的整份 `.env` 放进公开产物。控制台变量必须在发布前保存。详见 [deploy-delivery.md](./deploy-delivery.md) |
| EdgeOne 部署后部分请求 500 `INTERNAL_CLOUD_FUNCTION_NOT_READY`（"Cloud Functions not ready."，正文非 JSON） | 平台滚动新版本实例的发布切换窗口：`/healthz` 可能已成功而其余路由暂时 500，实测约 20s 自愈，**不是 delivery 业务错误**。先等待重试：`bun --no-env-file scripts/check-delivery-deployment.ts <分发域名>`（六项探测的暂态 5xx / HTML 404 / 网络错误在 120s 窗口内自动重试）；持续数分钟不恢复再查 Makers 控制台函数日志与部署状态。背景见 [deploy-delivery.md](./deploy-delivery.md) |
| 管理端「产物 → 播放」有总时长但一直转圈 | **对象桶 CORS 未放行管理端源站**（浏览器直连 COS 拉分片被拦；`curl -H "Origin: http://localhost:8787" <预签名分片 URL>` 可复现「200 但没有 `Access-Control-Allow-Origin`」）。到 COS 控制台加 CORS 规则：Origin 含管理端访问源站（本地 `http://localhost:8787`、CNB 预览 `https://*.cnb.run` 或 `*`）、Method `GET/HEAD`、Header `*`、ExposeHeader `ETag, Content-Length, Content-Range, Accept-Ranges` |
| `[worker] 缺少必需工具：ffmpeg, ffprobe` | 装 ffmpeg（`.ide/Dockerfile` 镜像已含） |
| 运行时报 `Cannot find module '@openvod/xxx'`（某 app 里） | **该 app 的 `package.json` 没声明这个 workspace 依赖**：bun 只给声明了依赖的包建软链，缺声明时从该包内解析不到（`packages/*` 之间同理）。补 `"@openvod/xxx": "workspace:*"` 后 `bun i`。已在 `packages/crypto`（→ shared）与 `apps/worker`（→ contracts）踩到过 |
| 管理端 `Error: [safe-delete]...SAFE_DELETE_BULK_CONFIRM_REQUIRED`（构建时） | Next 清理 `.next/turbopack` 触发环境的批量删除保护；先 `rm -rf apps/admin/.next` 再 `task build:admin` |
| 任务一直停在「排队中」 | **worker 没在跑**（最常见）：`bun scripts/dev.ts status` 看 worker 行；起起来用 `bun scripts/dev.ts all --background`（含 worker）或 `task dev:worker`。判据：该行 `attempts=0` 且 `lease_until` 为空 = 从未被任何消费者认领。若两者都非空，则是上一实例仍在执行或 lease 未过期（`WORKER_LEASE_MS`）|
| 任务反复失败 / `last_error` 提到「重试次数已达上限」 | Worker 崩溃循环；看 `last_error` 根因（常见：`MASTER_KEYS 不可用`、源片缺失、模板快照非法）。修好后在「转码任务」页重新发起。注：档位「全部被跳过」已不再判失败（2026-09-18 起改走源规格兜底产出，spec.md §5.4） |
| 「转码任务」页一直显示「连接中断，自动重连中…」 | SSE 长连接被中间层掐断或缓冲：浏览器会自动重连（端点已带 `no-store` / `X-Accel-Buffering: no`，反向代理需放行长连接）；若会话已过期，重连 401，重新登录即可 |
| 控制台页面卡住约 60s（`GET /xxx 200 in 60s`）并报 `⨯ Error: The destination stream closed early.`（浏览器侧另有 `Uncaught TypeError: network error`），末端跟随 `[Better Auth]: Provider "generic-oidc": discovery left no usable …` 或 `Discovery fetch failed` | 出口网络 / IdP 抖动时，better-auth 的 OIDC discovery（`${OIDC_ISSUER}/.well-known/openid-configuration`）**无超时**且落在 `auth.api.getSession()` 的首次调用路径上——也就是每个控制台页面（`requireConsoleSession()`），请求被拖到 TCP 超时（实测 132s；客户端 / 网关约 60s 先放弃，故表现为 60s + React 流被关）。provider 注册前已由 `apps/admin/src/lib/oidc.ts` 带 3s 超时预检：**未配置 issuer（DB 键与 env 皆空）时直接返回、不触网**；预检失败即本次实例不注册 generic-oidc（SSO 暂不可用，**本地邮箱密码登录不受影响**），日志 `[admin] OIDC discovery 预检失败（…）`。要恢复 SSO 需核对 `admin_oidc_issuer`（或 `OIDC_ISSUER`，CNB 走密钥注入、**不出现在 `.env`**）与容器出口网络 |
| Worker 停不掉 / 有看不见的残留消费者 | `bun --watch` 会吞 SIGTERM，必须整组 SIGKILL：用 `bun scripts/dev.ts stop worker`（按 `.run/worker.pid` 对进程组收尾）。若启动脚本曾被 `\| head`/`\| grep` 之类管道提前中断，pid 文件仍在，`bun scripts/dev.ts stop` 照样能收掉 |
| 管理端 `Fast Refresh had to perform a full reload due to a runtime error` | 通常是上面某类运行时错误的连带表现，先按上表修根因，再重启 `bun scripts/dev.ts admin` |
| 端口被占 / `已是运行状态` | `bun scripts/dev.ts status` 查看，`bun scripts/dev.ts stop` 停止；或换 `ADMIN_PORT` / `DELIVERY_LISTEN` |
| `bun scripts/dev.ts stop` 执行了，端口仍被占用（status 显示 `pid -`） | 占用者不是本启动器起的进程，典型是 **compose 容器**（`docker ps` 里 `openvod-admin-1` 映射 `0.0.0.0:9000->9000`）：`dev.ts` 只收 `.run/*.pid` 记录的进程组，容器要用 `docker compose stop admin` / `docker compose down`（连 worker 容器一起停）。注意 worker 必须单实例——容器 worker 在跑时别再用 dev 起 worker（两个消费者同抢 `transcode_jobs`），先 `docker compose stop worker` |
| `bun run --cwd packages/db exec ...` 报 `Script not found "exec"` | 用 `cd packages/db && ./node_modules/.bin/prisma ...` |
| 管理端显示的版本与发版 tag 不一致（如 UI 显示 0.1.0、tag 却是 0.2.0） | **版本号唯一真源是根 `package.json` 的 `version`**：子包 `package.json` 不得声明 `version`，展示只经 `apps/admin/src/lib/version.ts` 的 `APP_VERSION`（服务端读取后以 prop 下传客户端组件）。静态守卫 `apps/admin/test/version-source.test.ts` 随 `bun test` 执行，违规即失败；约定见 AGENTS.md §仓库约定 |

## 9. 目录与忽略规则

| 路径 | 说明 |
|---|---|
| `.env` | 本地密钥，不入库（真源在 CNB 密钥仓库） |
| `.run/` | `scripts/dev.ts` 的 pid / 日志 / delivery 二进制，以及 `edgeone-delivery/` 的暂存源码与受检查部署产物 |
| `packages/db/generated/` | Prisma 生成物（按方言，不入库） |
| `packages/db/prisma/*.db` | SQLite 开发库文件 |
| `packages/contracts/jsonschema/`、`apps/delivery/internal/contracts/` | 契约生成物，**需要入库** |
