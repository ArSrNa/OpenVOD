# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 权威指引

本仓库的编码 Agent 指引以 `AGENTS.md` 为唯一真源（与 `CODEBUDDY.md` 对齐维护）：命令全表、架构总览、ADR 索引、当前实现状态都在那里。**本文只补两件事**：Claude Code 在本仓库容易踩的前置条件，以及需要跨文件才能看出的关键约定（附 `file:line` 指针）。

@AGENTS.md

本仓库是 **ADR 驱动**：`docs/vod/decisions/0001~0014` 是设计决策的权威源，代码注释普遍以 `ADR-xxxx`、`spec.md §x` 引用。改动设计前先读对应 ADR；决策变化时同步回写 ADR 与 `docs/vod/spec.md`。高频坑集中在 `docs/vod/dev-workflow.md §8`（排错速查表）。

## 前置条件（不做必报错）

| 症状 | 原因 / 处理 |
|---|---|
| `Cannot find module '../generated/mysql'`（或 sqlite） | Prisma 生成物被 gitignore，未跑 `task db:generate`。**两份都必须生成**——`packages/db/src/index.ts:5-6` 静态导入 mysql + sqlite 两份客户端，缺一份则 Next 打包、`tsc --noEmit`、以及任何 import `@openvod/db` 的 `bun test` 全挂（本次会话实测：未生成时 `bun test` 93 过 2 失败，失败全为此因） |
| crypto 互通测试 / Go `token`、`mk` 测试被 skip | `packages/crypto/fixtures/crypto-v1.json` 未生成：先 `task vectors` |
| 转码任务一直停在「排队中」 | worker 没在跑。`./start.sh`（或 `./start-admin.sh`）会一并拉起；判据是任务行 `attempts=0` 且 `lease_until` 为空 |
| 改了 zod 契约但 CI 报 diff | `task contracts` 的生成物**必须入库**：`packages/contracts/jsonschema/` 与 `apps/delivery/internal/contracts/`（CI 门禁 `bun run check:contracts-go`） |
| 某 app 内 `Cannot find module '@openvod/xxx'` | 该 app 的 `package.json` 没声明这个 workspace 依赖（bun 只给声明了依赖的包建软链）；补 `"@openvod/xxx": "workspace:*"` 后 `bun i` |

没有 lint / format 脚本，也没有 ESLint / Prettier 配置。TS 侧可用的类型检查是 `cd apps/admin && bunx tsc --noEmit`（或 `task build:admin`，Next 构建会顺带类型检查）；Go 侧是 `cd apps/delivery && golangci-lint run`。

## 命令（本机工具链已核实：bun 1.4.2 / go 1.26.0 / node 25 / ffmpeg / task）

```bash
bun i                          # 装 workspace 依赖
sh scripts/gen-env.sh          # 生成根 .env（--force 覆盖 / --check 校验 / --stdout 预览）
task db:generate               # Prisma 两份客户端（改 schema 后必跑）
task db:push                   # SQLite 开发库建表（DB_PROVIDER=sqlite）
task db:parity                 # 两份 schema 的 enum/model 段逐字一致（CI 门禁）
task contracts && task vectors # 契约生成物 + 加密互通向量
./start.sh                     # 后台起 admin(:8787) + delivery(:9000) + worker；stop/status/logs <app>
task test                      # bun test + go -C apps/delivery test ./...
```

单测（两种语言，都不需要 Task）：

```bash
bun test apps/admin/test/users.test.ts            # 单个 TS 测试文件
bun test -t "resetUserPassword"                    # 按用例名 / describe 名过滤
go -C apps/delivery test ./internal/token -run TestTokenVerify -v   # 单个 Go 测试
```

## 架构要点（跨文件才能看清的部分）

**播放链路（ADR-0006，全系统最重要）**：`POST /v1/auth/login`（bcrypt → ES256 JWT，私钥 MK 封装在 `signing_keys`，`apps/delivery/main.go:79-112` 启动时解封）→ `POST /v1/media/{id}/play` 建可吊销 `playback_sessions` 并返回签名主清单 URL → delivery 读存储里的原始 m3u8 做**行级改写**（`apps/delivery/internal/playback/playlist.go`）把分片/密钥/字幕 URL 全部注入 HMAC 签名 token → 分片经 CDN 直出，**视频字节永远不经过函数** → 播放器调 `/key` 取 16B CEK 本地解密。
因为 Safari 原生 HLS 无法自定义分片/密钥请求头，鉴权**必须**走 URL query token（`typ=m/s/k/v`，`packages/shared/src/index.ts:20-25`）；JWT 只用于 login / media / play 业务 API。m3u8 与 key 响应一律 `Cache-Control: no-store`。

**两套鉴权体系，勿混用**：播放端 `users`（管理端维护，delivery 签 JWT）vs 管理端 `admin_users`（better-auth + httpOnly Cookie，配置在 `apps/admin/src/lib/auth.ts`，ADR-0012/0013 双轨）。

**存储键布局**（`packages/shared/src/index.ts:32-61`）：业务代码只拿**不含 root 的相对键**，`STORAGE_ROOT_PREFIX` 由适配层统一拼剥（`packages/storage/src/prefix.ts:7-17`）。产物按「媒资 → 模板」两级分组：`proceed/{mediaId}/{templateId}/`，目录名即模板 ID（ADR-0014）；字幕等非转码产物走保留段 `proceed/{mediaId}/subtitles/`。同一媒资多套模板产物**共用一份 CEK/kid**（`media_id` 有 DB 唯一约束）。

**任务队列**（`apps/worker/src/job-store.ts:60-101`）：不引 Redis，靠 CAS `updateMany`（状态 + lease 过滤，`count===1` 才算认领）在 MySQL / SQLite 上语义一致；`lease_until` 过期即崩溃重派，`attempts >= WORKER_MAX_ATTEMPTS` 直接判 FAILED。执行期用心跳 `extendLease` 续租。转码链在 `apps/worker/src/executor.ts`，顺序即安全边界：解封/生成 CEK → 写 `key_info`（明文只在这两个瞬间存在）→ ffmpeg → 上传 → **上传成功才落 `hls_keys`** → `finally` 清理临时密钥文件。

**双语言契约防漂移**：`packages/contracts/src/index.ts` 的 zod schema 是 DTO 唯一真相源 → `gen-json.ts` 出 JSON Schema → `gen-go.sh` 用 quicktype 出 Go struct。URL 签名 token / MK 封装（AES-256-GCM）在 TS（`packages/crypto`）与 Go（`apps/delivery/internal/{token,mk}`）各有一份实现（`packages/crypto` 的 TypeA 实现为废弃保留，不接入链路），靠 `packages/crypto/fixtures/crypto-v1.json` 共享向量保证互通——改任一侧必须重跑 `task vectors` 并跑两端测试。

**Go 侧不用 Prisma**：`database/sql + sqlx`，只读读模型 + `playback_sessions` 读写，用受限 DB 账号（ADR-0011）。表结构对齐靠 `task db:parity` 与集成测试。分发端链路的规范性（normative）文档是 `docs/delivery/video-stream-standard.md`（「必须/禁止」按 RFC 2119 理解），改 delivery 行为前先对一遍。

## 代码约定

- **注释与 UI 文案用中文**，标识符用英文。注释解释「为什么」并引用 ADR / spec 小节（例：`// 双方言一致性检查（ADR-0004）`）。
- **提交**：conventional commits + 中文简述，形如 `feat(admin): 实现播放端用户管理`；PR 走 CNB 平台（`.agents/skills/cnb-code-commit` 有分支命名与推送流程）。
- **新增管理端 API 端点**：在 `src/app/api/admin/<resource>/route.ts` 建文件（Next 优先于 `[...path]` catch-all），`getAdminSession(req)` 守卫 + `unauthorized()`，业务逻辑放 `src/lib/<resource>.ts`，成功 `apiJson` / 失败 `apiError`（错误码取 `@openvod/shared` 的 `ERROR_CODES`），敏感操作过 `auditAction`。信封独立成 `src/lib/envelope.ts` 的理由见该文件头注释（避免 import 图把 Prisma 单例拖进纯单测）。
- **管理端表格**：表体限高 + 表头固定 + 内部滚动，统一复用 `apps/admin/src/components/tableScroll.ts` 的 `useTableBodyHeight`，不得各自实现（spec.md §3.0 强制）。
- **antd v5 × React 19**：`@ant-design/v5-patch-for-react-19` 必须在客户端组件里引入（`src/app/providers.tsx`），放 root layout 不生效。
- **密钥纪律**：明文 CEK 只存在于转码期与 `/key` 响应瞬间；落库只有 `wrapped_cek` + `iv` + `kid` + `mk_ver`。管理端页面**不提供任何明文密钥的查看 / 导出入口**；用户页面不提供口令 / 哈希入口。
- **测试**：TS 用 `bun:test`，被测函数多为依赖注入的纯编排（fake store / 注入 deps，不连真库）；Go 用标准 `testing`。写测试时沿用同目录既有风格。
