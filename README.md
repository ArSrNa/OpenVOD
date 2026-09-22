# OpenVOD

自建云点播系统：媒资库、转码、加密分发（HLS AES-128 + URL 签名）、元数据、WebVTT 字幕。

- 决策文档：[docs/vod/README.md](./docs/vod/README.md)（intent + ADR-0001 ~ 0013 + open-questions）
- 开发流程：[docs/vod/dev-workflow.md](./docs/vod/dev-workflow.md)（环境准备、启动、数据库、建号、排错）
- 管理端 Control Plane：`apps/admin`（Next.js 全栈 UI + API + better-auth + Prisma，ADR-0013）、`apps/worker`（ffmpeg 常驻容器，ADR-0008）
- 分发端 Data Plane：`apps/delivery`（Go 1.26 + Chi，EdgeOne Cloud Functions / SCF 容器）

## 快速开始

```bash
bun i                     # 安装依赖（workspaces）
sh scripts/gen-env.sh     # 生成 .env（优先取环境变量；无则回落 .env.example）
task db:generate          # 生成 Prisma 客户端（mysql + sqlite 两份，缺一 Next 无法打包）
task db:push              # 开发库建表（SQLite）
task contracts            # zod → JSON Schema → Go struct（生成物入库，ADR-0001 门禁）
task vectors              # 生成 TS/Go 加密互通测试向量

bun scripts/dev.ts        # 启动服务（交互式选服务 + 前台/后台；日志在 .run/）
task test                 # bun test + go test
```

`bun scripts/dev.ts` 是 TS 版启动器（`scripts/dev.ts`，取代旧 `./start*.sh`）：无参数时交互式勾选要启动的服务与运行方式，
也可以直接带参数；端口跟随根 `.env` 的 `ADMIN_PORT` / `DELIVERY_LISTEN`。

| 组件 | 端口 | 启动命令 |
|---|---|---|
| 管理端 admin（UI + API） | `:8787`（`ADMIN_PORT`） | `bun scripts/dev.ts admin`（**同时后台起 Worker**）或 `task dev:admin` |
| 分发端 delivery | `:9000`（`DELIVERY_LISTEN`） | `bun scripts/dev.ts delivery` 或 `task dev:delivery` |
| 转码 Worker | — | `bun scripts/dev.ts worker` 或 `task dev:worker`（需 ffmpeg / ffprobe）；起 admin 时自动一并带起 |
| 全部（后台） | — | `bun scripts/dev.ts all --background`（admin + delivery + worker），另支持 `stop`、`status`、`logs <服务>` |

数据库选择（SQLite / MySQL）、管理员建号、常见报错处理见
[docs/vod/dev-workflow.md](./docs/vod/dev-workflow.md)；
工具链要求见 `.ide/Dockerfile`（Bun 1.4 / Go 1.26 / ffmpeg / quicktype / Task）。

## 环境变量与 `.env`（scripts/gen-env.sh）

`.env` 已被 `.gitignore`，**真源是 CNB 密钥仓库**，不在代码仓内落盘：

```
密钥仓库 env.dev.yml ──(imports 注入为环境变量)──> .cnb.yml vscode 流水线
      └──> scripts/gen-env.sh ──> /workspace/.env（600）──> scripts/dev.ts / Taskfile / 终端
```

`scripts/gen-env.sh` 是零依赖的 POSIX sh 脚本，把「环境变量」还原成 `.env`：

| 用法 | 说明 |
| --- | --- |
| `sh scripts/gen-env.sh` | 生成 `.env`（已存在则跳过） |
| `sh scripts/gen-env.sh --force` | 覆盖已有 `.env`（密钥轮换后用；云原生开发 stage 即用此） |
| `sh scripts/gen-env.sh --stdout` | 只打印结果不落盘（排查用） |
| `sh scripts/gen-env.sh --check` | 校验必需变量齐全且非 `.env.example` 占位值（`STRICT=1` 时非空退出 1） |
| `sh scripts/gen-env.sh -o apps/admin/.env -t .env.example` | 指定输出文件 / 模板 |

取值来源二选一（前者优先）：

1. **整体**：`OPENVOD_ENV_B64` —— 完整 `.env` 的 base64，一行搞定、不会丢特殊字符：
   ```bash
   base64 -w 0 .env                       # 本地生成（macOS: base64 -i .env）
   OPENVOD_ENV_B64=... sh scripts/gen-env.sh --force
   ```
2. **逐项**：以 `.env.example` 为模板，用同名环境变量覆盖；模板里没有的键用
   `EXTRA_ENV_KEYS` 追加（`EXTRA_ENV_KEYS=MYSQL_ROOT_PASSWORD,MYSQL_PASSWORD`）。

### 密钥仓库配置（云原生开发）

建一个「密钥仓库」（如 `arsrna/media/openvod-secrets`），Web 端新建 `env.dev.yml`：

```yaml
allow_slugs: "arsrna/media/openvod"   # 仅本项目可引用（声明任一 allow_* 则全部参与校验）
OPENVOD_ENV_B64: "RGFUQUJBU0VfVVJMPS4uLg=="
# 或逐项写法：DATABASE_URL: "..."、MASTER_KEYS: "1:<64位hex>" ...
```

`.cnb.yml` 的 vscode 流水线已接好（先 `imports` 再生成 `.env`，并让新终端自动 source）：

```yaml
imports:
  - https://cnb.cool/arsrna/media/openvod-secrets/-/blob/main/env.dev.yml
stages:
  - name: 从密钥仓库注入 .env
    script: sh scripts/gen-env.sh --force
```

要点：

- `.cnb.yml` 里 `env:` 优先级**高于** `imports`，别声明同名变量覆盖密钥。
- 轮换密钥只改密钥仓库文件，下次启动开发环境生效。
- `MASTER_KEYS` 必须 admin(TS) 与 delivery(Go) 完全一致；`URL_SIGN_KEY_HEX` 为 64 位 hex。
- 开发环境建议 `DB_PROVIDER=sqlite` + `DATABASE_URL="file:./dev.db"`（`task db:push` 建表）；
  连 MySQL / TDSQL-C 时的客户端生成、迁移与空库 baseline 流程见
  [dev-workflow §4](./docs/vod/dev-workflow.md)。
