@CODEBUDDY.md

# AGENTS.md

本文件为在此仓库工作的编码 Agent 提供指引（内容与 `CODEBUDDY.md` 对齐）。

## 沟通约束（所有 Agent 必须遵守）

用户的要求：**说人话**。适用于回复、文档、提交信息、PR 描述与注释。

- 先给结论，再给理由；一句话能说清就不写三句。
- 不铺垫背景、不复述问题、不预告"接下来我会……"、不在结尾加"希望对你有帮助"。
- 不用黑话和 AI 腔：赋能 / 闭环 / 抓手 / 心智 / 拉通 / 对齐颗粒度 / 打法 / 组合拳 / 护城河 / 降维打击 / 让我们 / 值得注意的是 / 综上所述 / 总而言之；也不堆"完美、极致、颠覆、革命性"这类没有信息的形容词。
- 不靠对仗句式凑字数（"不是 A，而是 B"、"不仅 A，而且 B"反复出现就是套路）。
- 不确定就直说不确定，并给出验证方式；不编造事实、数字、路径、接口或测试结果。
- 术语、命令、路径、字段名、ADR 编号照原样写；技术表达要精确，通俗不等于含糊。
- **描述性信息（界面帮助文本、提示、说明、文档段落）先筛选再写**：只留用户要做的动作，以及会直接导致失败的硬限制（必填、取值范围、冲突、不可逆后果、必须和对方系统对齐的取值）。功能是什么、内部怎么实现一概不写，用户不需要科普。一句话说得清就别写两句；"就是用来……的""支持……""通过……实现"这类句式直接删。
- **最强约束（最终约束，任何 Agent 不得逾越）**：用户可见的任何文字——帮助文本、提示、说明、空状态、报错——都不得出现技术性注释与实现细节：存储位置、缓存、接口、数据库、算法，以及生效范围（"只存在当前浏览器""换设备要重新选""下次登录失效"之类）一律不出现。不允许以"帮用户理解"为由加回来；违反即返工。

## 项目概况

OpenVOD：自建云点播系统（媒资 → 转码加密 → 元数据 / 字幕 → 鉴权分发播放）。Bun workspaces monorepo，双语言双端架构，部署目标为腾讯云 EdgeOne Pages / SCF（Docker），保留自托管 Compose 退路。

本仓库是 **ADR 驱动**开发：`docs/vod/decisions/0001~0013` 是权威决策源，代码注释普遍以 `ADR-xxxx` 引用；改动设计前先读对应 ADR，决策变化时同步更新 ADR。排错先查 `docs/vod/dev-workflow.md §8`（`Module not found: '../generated/sqlite'`、`P2021`、`P3014` 等高频坑均有条目）。

## 常用命令

### 执行约束（用户要求）

- Node.js 生态相关操作统一使用 Bun 运行时，包括依赖安装、脚本执行、开发、构建和测试。
- 安装依赖使用 `bun install` / `bun add`；执行 CLI 使用 `bunx --bun`、`bun run --bun` 或 `bun <脚本路径>`。不要使用 npm、npx、pnpm、yarn 或直接调用 node；工具的 Node shebang 也须显式由 Bun 执行。
- Go 等非 Node.js 工具继续使用原生工具链。

工具链要求：Bun ≥1.4、Go 1.26、Node 22+、ffmpeg/ffprobe、Task（可选，无 Task 时直接看 `Taskfile.yml` / `package.json` 里的原始命令）；云原生开发镜像 `.ide/Dockerfile` 已内置全部工具。

| 命令 | 说明 |
|---|---|
| `bun i` | 安装 workspace 依赖 |
| `sh scripts/gen-env.sh` | 生成根 `.env`（`--force` 覆盖、`--check` 校验、`--stdout` 预览）。`.env` 不入库，真源是 CNB 密钥仓库；开发容器会把变量写进 `~/.bashrc` |
| `task db:generate` | 生成 mysql + sqlite 两份 Prisma 客户端。缺任一份 Next 打包即报 `Module not found`，改 schema 后必须重跑 |
| `task db:push` | SQLite 开发库建表（`DB_PROVIDER=sqlite`） |
| `task db:migrate` | 生产 MySQL 迁移（`prisma migrate deploy`）；空库 baseline 四步流程见 dev-workflow §4.3 |
| `task db:parity` | 校验两份 Prisma schema 的 enum/model 段逐字一致（CI 门禁） |
| `task contracts` | zod → JSON Schema → Go struct（quicktype）。生成物**必须入库**，CI 用 `bun run check:contracts-go` diff 门禁 |
| `task vectors` | 生成 TS/Go 加密互通测试向量；未生成时两端互通测试会 skip |
| `bun scripts/dev.ts` | 开发启动器（TS，取代旧 `./start*.sh`）：交互式勾选服务（admin / delivery / worker）与运行方式（前台调试 / 后台常驻），端口跟随 env 文件的 `ADMIN_PORT` / `DELIVERY_LISTEN`（默认根 `.env`，`--env-file <路径>` 可指定替代文件，指定后不读根 `.env`） |
| `bun scripts/dev.ts all --background` | 后台一键启动全部（等价旧 `./start.sh`），含 **worker（转码队列消费者，必须一起跑）**；子命令 `stop` / `status` / `logs <服务>`；pid 与日志在 `.run/`（worker 无端口，用 pid 判定存活，`setsid` 独立进程组整组收） |
| `bun scripts/dev.ts admin` | 前台管理端调试。**会自动一并启动 Worker**（后台，日志 `.run/worker.log`），退出时一并收掉；已在跑则沿用不动它 |
| `bun scripts/dev.ts delivery` | 前台分发端调试（自动增量 `go build` 到 `.run/delivery`，`task dev:delivery` 同源） |
| `bun scripts/dev.ts worker` | 前台单跑转码 Worker（观察认领 / 转码日志用） |
| `task dev:worker` | 转码 Worker（Bun `--watch`，需 ffmpeg/ffprobe，缺失直接退出） |
| `sh scripts/compose-infra.sh up` | **本地体验底座**（MySQL + RustFS 容器，编排 `docker-compose.infra.yml`，项目名 `openvod-infra`，与根编排互不影响）：up 自动生成凭据 `.run/infra.env`、等 mysql 健康、建分发端受限账号 `openvod_ro`（ADR-0011）；另有 `down` / `reset`（删卷清数据）/ `ps` / `logs` / `init-env`（生成 `.env.trial`，**不动根 .env**）/ `env`（打印连接串）/ `url`。三端启动用 `bun scripts/dev.ts --env-file .env.trial ...`。**用户说「启动一个体验环境」时，按 `docs/vod/trial-env.md` 的 Runbook 执行** |
| `task test` | `bun test` + `go -C apps/delivery test ./...` |
| `bun test packages/crypto/test/interop.test.ts` | 运行单个 TS 测试文件；`bun test -t "用例名"` 按名称过滤 |
| `go -C apps/delivery test ./internal/token -run TestTokenVerify -v` | 运行单个 Go 测试 |
| `task build:admin` | 管理端生产构建（前置 `task db:generate`） |
| `task build:delivery` | 分发端静态二进制 → `apps/delivery/bin/delivery` |
| `task image:delivery` | 分发端镜像；SCF 仅 x86，必须显式 `--platform linux/amd64` |
| `bun apps/admin/scripts/create-admin.ts <email> <password≥8位> [名称]` | 创建本地管理员账号，要求目标库已建表 |
| `bun apps/admin/scripts/bootstrap-playback.ts <用户> <密码≥8位> [显示名] [--rotate-jwt-key]` | 播放链路引导（幂等）：生成 JWT 签名密钥（MK 封装入 `signing_keys`）+ 创建/重置播放端用户；分发端 login 依赖它 |
| `bun run --cwd packages/db studio` | Prisma Studio 查看数据 |
| `cd apps/delivery && golangci-lint run` | Go 静态检查（开发镜像已含，无 Task 封装） |

测试前置：先 `task vectors`，否则 crypto 互通与 Go token 测试均以 fixture 缺失跳过。

### 本地开发与 `apps/admin/.next` 占用（用户要求）

用户开发期**常驻 `bun dev`（= `bun scripts/dev.ts`：admin / delivery / worker）**，它会长期占用 `apps/admin/.next`。
Agent 需要「看到改动」而与 dev server 冲突时（典型：`next build` / `task build:admin`、清理 `.next`、重启 dev），
**先帮用户停掉，做完再恢复**，不要与它在 `.next` 上抢锁：

```bash
bun scripts/dev.ts status          # 先看是否在跑（含 worker；pid 在 .run/）
bun scripts/dev.ts stop            # 停全部（也可只停 admin / delivery / worker）
# … 构建 / 清理 / 验证 …
bun scripts/dev.ts all --background   # 需要恢复时按原样起回（含 worker），或提示用户自行重启
```

- **不需要停 dev 的操作**：`tsc --noEmit`、`bun test`、`go test`、`task db:*`、`task contracts`、`task vectors` 都不碰 `.next`，直接跑。
- **需要先停**：`next build`（`task build:admin` / `bun run --cwd apps/admin build`）、任何 `rm -rf apps/admin/.next`、
  改 `next.config.ts` 或需重启 dev 的改动（环境变量、依赖变更）。
- `next build` 会清理 `.next`：本机上可能触发环境的批量删除保护（`[safe-delete] SAFE_DELETE_BULK_CONFIRM_REQUIRED`），
  此时先 `rm -rf apps/admin/.next` 再构建（同 `docs/vod/dev-workflow.md §8`）。
- 占用者不是启动器起的进程时（`status` 显示 `pid -`，典型是 compose 容器），用对应方式停：
  `docker compose stop admin`（注意 worker 必须单实例，别与容器 worker 抢队列）。
- Agent 停掉用户的 dev server 后若不再需要它（例如只跑一次构建），**在回复里明确告知已停与如何恢复**，不要静默停服务。

## 架构

### 组件与播放链路

```
播放端 App ──JWT──▶ apps/delivery（Go 1.26 + Chi，:9000）   热路径 / Data Plane
管理台    ──Cookie▶ apps/admin（Next.js 全栈，:8787）        控制面 / Control Plane
                    └─ apps/worker（Bun 常驻）ffmpeg/ffprobe 转码
共享：MySQL(TDSQL-C)/SQLite + 对象存储（local / S3 兼容 COS/MinIO）
```

核心播放流程（ADR-0006，全系统最重要）：App `POST /v1/auth/login` 取 ES256 JWT → `POST /v1/media/{id}/play` 创建可吊销 `playback_sessions` 并返回签名主清单 URL → delivery 从存储读原始 m3u8 做行级改写，将分片 / 密钥 / 字幕 URL 全部注入签名 token → 分片经 S3 预签名直出（COS 私有桶；可配 `STORAGE_CDN_BASE_URL` 加速域名；ADR-0019：签名形态管理端可配——`s3_presign` 默认 / `cdn_url_auth`（CDN 私有回源 + EO Token 鉴权 A/B/C/D/V 全内置）/ `custom`），**视频字节永远不经过函数** → 播放器调 key 接口取 16B CEK 本地解密。

关键原因：Safari 原生 HLS 的分片与密钥请求无法自定义请求头，因此播放资源的鉴权**必须**全部走 URL query 签名 token（`typ=m 清单 / s 分片 / k 密钥 / v 字幕`），JWT 只用于 login / media / play 业务 API。m3u8 与 key 响应必须 `Cache-Control: no-store`（P0 纪律，CI 门禁 `assert-unsigned-403` / `assert-no-store`）。

### 契约与双语言互通（防漂移）

- `packages/contracts/src/index.ts` 的 zod schema 是 API DTO 唯一真相源；`task contracts` 经 JSON Schema → quicktype 生成 Go struct 到 `apps/delivery/internal/contracts/`，生成物入库 + CI diff 门禁是唯一防漂移手段。
- URL 签名 token、MK 封装（AES-256-GCM）在 TS（`packages/crypto`）与 Go（`apps/delivery/internal/token`）各有一份实现（`packages/crypto` 的 `typea.ts` / `edgeone.ts` 为资产 URL 鉴权算法，ADR-0019 起已接入 `cdn_url_auth` 链路、EO 方式 A/B/C/D/V 全内置），靠 `packages/crypto/fixtures/` 共享向量（`crypto-v1.json` / `url-sign-v1.json` / `url-sign-eo-methods-v1.json`）保证互通；改任一侧必须重跑 `task vectors` 与两端测试。
- `packages/shared` 存放错误码、token 类型、存储键布局、TTL 默认值等跨端常量（Go 侧无生成，手工对齐）。

### 数据层

- Prisma 是 schema 唯一真相源：`packages/db/prisma/schema.mysql.prisma` 与 `schema.sqlite.prisma` 的 enum/model 段必须逐字一致。MySQL 为生产准绳（迁移仅由 `packages/db` 执行，必须 expand-contract 向后兼容）；SQLite 仅限本地开发与单机同卷自托管（`db push`），跨机器 / 云函数部署必须 MySQL。
- `packages/db/src/index.ts` 静态导入两份生成客户端、按 `DB_PROVIDER` 实例化其一——这是两份客户端缺一不可的根因。
- Go 侧不用 Prisma：`database/sql + sqlx` 只读读模型 + 播放会话写入，靠集成测试对齐表结构。
- 任务队列不引入 Redis：MySQL `FOR UPDATE SKIP LOCKED` / SQLite CAS 认领，带 `lease_until` 崩溃重派（ADR-0004/0008）。

### 两套鉴权体系（勿混用）

- 播放端 `users`：管理端维护、bcrypt 哈希；由 **delivery** 签发 ES256 JWT（私钥存 `signing_keys` 且以 MK 封装），默认 TTL 24h，v1 无 refresh。
- 管理端 `admin_users`：better-auth（`genericOAuth` OIDC + 本地邮箱密码双轨），httpOnly Cookie 承载 DB 会话（可吊销）；配置在 `apps/admin/src/lib/auth.ts`，Prisma adapter 复用 `packages/db`。

### 密钥分层（ADR-0006）

```
MK（环境变量 MASTER_KEYS="版本:64位hex"，可轮换）
 ├─wrap→ CEK（16B AES-128，每媒资随机）→ 加密 HLS 分片
 ├─wrap→ JWT ES256 私钥（入 signing_keys）
```

明文 CEK 只存在于转码瞬间与密钥接口响应瞬间；轮换与吊销语义（MK 重封装免重转码、会话吊销 ≤60s 收敛、双 kid 宽限）见 ADR-0006 §6。

### 部署形态与硬约束（ADR-0003 / 0011）

- delivery 同一份 Go 静态二进制的两个同级目标：EdgeOne Pages Cloud Functions（Go 1.26）或 SCF 容器；无内网依赖，数据库必须公网可达 + 强制 TLS。
- admin 为一个 Node 22 容器（`next build` + `next start`，UI/API 同源无 CORS）；worker 为 Bun 常驻容器。
- P0 硬约束：转码禁止上任何函数；分片字节不经过函数；所有响应体 ≤6MB；SCF 镜像仅 x86。
- 两应用共享一库一桶但独立发版；delivery 使用受限 DB 账号（约定表只读 + `playback_sessions` 读写），绝不能共用管理端全权账号；存储键前缀即隔离（`original/` 仅管理端写，布局见 `docs/vod/spec.md §1`）。

### 当前实现状态（scaffold 骨架）

- `apps/delivery` **播放链路（M3）已实现**：`internal/{config,contracts,server,token,auth,blob,mk,playback,store}`——login（bcrypt + ES256 JWT，私钥自 `signing_keys` 解封）、media 列表/详情、play（会话幂等复用 / `force_new` / 并发上限 / 多模板产物自动或显式选择）、主 + 子清单改写（`EXT-X-KEY` URI → token(k)、分片 → S3 预签名直出）、`/key`（MK 解封 16B CEK，`no-store`）、**字幕下发**（`play` 附 typ=v 签名 URL；`.vtt` 验签 + 会话 → 按 `storage_key` 代理输出 `text/vtt` + `no-store`，spec.md §7.5）；无签名 403。规则与未覆盖项（限频、严格模式）见 `docs/vod/spec.md §6`（CDN + EO TypeA 已于 2026-09-20 关闭：s3 预签名直出定稿；local 驱动已于 2026-09-22 移除：仅 S3 兼容存储，ADR-0005 修订；分发端 SQLite 已于 2026-10-17 支持，ADR-0011 修订）。**三端共用 `DATABASE_URL`**（需要分权时给 delivery 进程单独传受限账号的值）。管理端「产物 → 播放」预览由后端以预览账号（`DELIVERY_BASE_URL` / `DELIVERY_PREVIEW_USERNAME|PASSWORD`）换签名主清单 URL，浏览器用 Video.js v10（`@videojs/hlsjs-video`）直连分发端播放——**密钥仍只由分发端下发**；跨域由 `DELIVERY_CORS_ORIGINS` 控制（默认 `*`），还需对象桶 CORS 放行管理端源站（否则「有总时长但一直转圈」，见 dev-workflow §8）。
- `apps/worker/src/index.ts` 的 `tick()` 为空实现，注释列出 ADR-0008 的完整流程（认领 → ffprobe → key_info → 转码 → 上传 → 写 `hls_keys`）。
- `apps/admin` 的 `/api/auth/*`（better-auth）、`/healthz`、登录页与建号脚本可用；`/api/admin/*` 业务端点按里程碑逐条落地——已实现：媒资（上传 / 列表 / 详情 / 重命名 / 删除 / 预览 / 封面 / 元数据 / 产物 / 转码发起）、`/api/admin/templates`、`/api/admin/keys`（含 MK 轮换）、`/api/admin/jobs`（列表 + SSE + 停止 / 重启）、`/api/admin/stats`、`/api/admin/users`（播放端用户 CRUD + 重置口令 + 吊销会话，spec.md §2.1.1）、`/api/admin/media/{id}/subtitles`（字幕轨道 CRUD + 覆盖文本，spec.md §7）；其余路径仍由 `/api/admin/[...path]` 会话守卫后返回 501。

## 仓库约定

- **生成物入库规则**：`packages/contracts/jsonschema/` 与 `apps/delivery/internal/contracts/` 必须提交；`packages/db/generated/`、`.env`、`.run/`、`packages/db/prisma/*.db` 已忽略。改契约不提交生成物 = CI 失败。
- **版本号唯一真源**：全仓库版本号只认**根 `package.json` 的 `version`**，发版只改它（CNB `auto_tag` 读的也是它）。`apps/*` / `packages/*` 的 `package.json` **一律不声明 `version`**——历史包袱：admin 曾 `import pkg from "../../package.json"` 取本包版本，于是 UI 显示 0.1.0 而发版 tag 是 0.2.0，同一仓库两个版本号。管理端展示只经 `apps/admin/src/lib/version.ts` 的 `APP_VERSION`（**服务端**读取后以 prop 下传客户端组件，避免整份 JSON 进客户端 bundle）；新增展示点一律复用该常量，**不得再读任何 `package.json`**。静态守卫 `apps/admin/test/version-source.test.ts` 随 `bun test` 执行，违规即失败。
- 提交规范 conventional commits；v1 不引入 changesets（ADR-0001）。
- 文档索引：`docs/vod/README.md`（架构图 + ADR 索引 + 术语表）、`intent.md`（目标 / 非目标 / 验收里程碑）、`api.md`（**HTTP API 参考**：管理端 + 分发端全部端点与错误码）、`open-questions.md`（specification 前待关闭项）、`dev-workflow.md`（启动 / 数据库 / 建号 / 排错）、`trial-env.md`（**「启动一个体验环境」Runbook**：MySQL + RustFS 底座 + 三端起全的固定流程）。
