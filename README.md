# TODO

# OpenVOD

手搓点播系统，集成媒体、分类、转码、分发、字幕管理。这是一个AI开发友好的项目。

还加入了特色，超级色的功能，媒体加密，按用户实现不同分发策略

## AI友好

为什么AI友好，开发所需要的文档已经全部在里面，当然不需要你全部读懂，因为这些词语太晦涩难懂，AI和AI自己构造出了一套语言系统，自顾自地在那聊正嗨呢，我们不需要插手。开发需要做的，就是准备一些`词元（token）`，以及一个强大的Agent，根据下列文档，把你的需求，出现的问题，告诉你的Agent即可：

- 决策文档：[docs/vod/README.md](./docs/vod/README.md)（intent + ADR-0001 ~ 0013 + open-questions）
- 开发流程：[docs/vod/dev-workflow.md](./docs/vod/dev-workflow.md)（环境准备、启动、数据库、建号、排错）
- 管理端 Control Plane：`apps/admin`（Next.js 全栈 UI + API + better-auth + Prisma，ADR-0013）、`apps/worker`（ffmpeg 常驻容器，ADR-0008）
- 分发端 Data Plane：`apps/delivery`（Go 1.26 + Chi，EdgeOne Cloud Functions / SCF 容器）

# Reference
Readme里内容和展现方式有限，最新和最详细的文档，请查询我们的文档库：https://arsrna-it.feishu.cn/drive/folder/TY3lf4NNIlhgXKd6t2acnItMnAg?from=from_copylink

- [OpenVOD-接入指南](https://arsrna-it.feishu.cn/docx/QcxCdkqCvoPo4hx1OMvcf7yUnjf)

# 开始

## 准备
### 开发环境
如果你在CNB上那恭喜你，可以省去配置Node和Go环境的步骤，Fork此仓库，直接点击云原生开发即可运行

Nodejs（bun）与Go，可以在他们的官网找到对应的安装方式，此处不再赘述

### 密钥仓库
由于云原生开发直接把密钥写在.env里面保存有泄露风险，且不适合项目迁移，所以建议使用密钥仓库，详细可在：https://docs.cnb.cool/zh/repo/secret.html 查询。

密钥仓库和`.env`格式不一样，使用的是yaml，类似这样
```yaml
key: "value"
```
而env则是
```dotenv
key=value
```

### 存储
#### S3
为了开发方便及最大程度分离各端保证性能，主要存储已经挪到了对象存储，支持所有S3协议的对象存储，例如腾讯云COS、AWS S3、阿里云OSS、华为云OBS、Minio、RustFS等。

你需要提供（以下示例为腾讯云COS）

- 接入点 `Endpoint`，需要带上协议，例如`https://cos.ap-guangzhou.myqcloud.com`
- 地域 `Region`，例如`ap-guangzhou`
- 存储桶 `Bucket`，例如`openvod-130000000001`
- 访问密钥 `SecretId`，例如`AKID9100000000000000000000000000000000`
- 访问密钥 `SecretKey`，例如`AKID9100000000000000000000000000000000`
- 加速域名（可选），为了防止COS公有读造成的权限和安全问题，建议使用CDN后私有回源，使用加速域名还可以节省流量开支。更多请参考[接入文档](#接入文档)
- Path-Style寻址，为了兼容S3协议，部分S3不支持Path-Style，例如腾讯云是`{bucket-name}.cos.{region}.myqcloud.com`，更多请参考[接入文档](#接入文档)，Minio是`{endpoint}/{bucket-name}`，需要知道你的S3厂商支持的方式

**安全实践：访问密钥建议使用子账号，并只授予对应存储桶的读写权限**

### 数据库
目前支持sqlite与MySQL数据库，sqlite仅用于开发环境，生产环境建议使用MySQL，MySQL支持主从架构，可以实现高可用。

数据库必须能够三端访问，详情见[接入文档](#接入文档)

## 启动

你可以直接与你强大的Agent说

> 请你根据开发流程文档`docs/vod/dev-workflow.md`里的说明，帮我配置完毕开发环境

如果不放心，也可以根据下列步骤来进行

```bash
# 安装依赖（workspaces）
bun i                     
# 生成 .env（优先取环境变量；无则回落 .env.example）
sh scripts/gen-env.sh     
# 生成 Prisma 客户端（mysql + sqlite 两份，缺一 Next 无法打包）
task db:generate    
# 开发库建表（SQLite）      
task db:push         
# zod → JSON Schema → Go struct（生成物入库，ADR-0001 门禁）     
task contracts            
# 生成 TS/Go 加密互通测试向量
task vectors              
# 启动服务（交互式选服务 + 前台/后台；日志在 .run/）
bun scripts/dev.ts     
# bun test + go test   
task test                 
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
