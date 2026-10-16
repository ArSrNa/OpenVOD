# 管理端 / Worker / 播放端镜像

管理侧是**一个应用、两个进程**（ADR-0011：「两应用 + N 进程」）：admin 与 worker 各自一个容器，
同宿主并用一份编排（compose 示例属 ADR-0011 未交付项，见文末）。另有一个**播放端 Demo**（`player`，
spec.md §11：独立第三镜像——免登录、只消费分发端 `/v1` API，与管理侧共享 workspace 依赖但不依赖数据库）。
分发端是完全分开的另一个应用，其部署见 [deploy-delivery.md](./deploy-delivery.md)。

| 镜像 | Dockerfile | 运行时 | 端口 |
|---|---|---|---|
| `admin` | `apps/admin/Dockerfile` | Node 22（`next start`） | `:8787` · `GET /healthz` |
| `worker` | `apps/worker/Dockerfile` | Bun 常驻 | 见下（ADR-0017 双模式） |
| `player` | `apps/player/Dockerfile` | Node 22（`next start`） | `:3100` · `GET /healthz` |

worker 端口取决于 `WORKER_MODE`（ADR-0017）：`resident`（默认）无端口，轮询认领 `transcode_jobs`；
`http`（serverless 门铃）监听 `WORKER_HTTP_PORT`（默认 `9001`）：`POST /wake` 触发认领
（Bearer `WORKER_NOTIFY_SECRET`），`GET /healthz` 供平台探活。镜像与 compose 均已内置
模式感知 HEALTHCHECK（http 探 /healthz；resident 看进程）。

## 构建上下文必须是仓库根

三个 app 都经 `workspace:*` 依赖 workspace 包，且直接消费其 **TS 源码**（admin 走 `transpilePackages`；
player 经 `@openvod/contracts`）。所以上下文是仓库根、用 `-f` 指 Dockerfile：

```bash
task image:admin      # docker build -f apps/admin/Dockerfile -t openvod-admin:latest .
task image:worker     # docker build -f apps/worker/Dockerfile -t openvod-worker:latest .
task image:player     # docker build -f apps/player/Dockerfile -t openvod-player:latest .
```

（对比：delivery 是纯 Go、自带 `go.mod`，上下文是 `apps/delivery`——见 deploy-delivery.md。）

根目录的 `.dockerignore` 负责裁剪上下文：剔除 `node_modules` / `.next` / `packages/db/generated`（镜像内重建）、
`.env*`（密钥绝不入镜像）与 docs / videos / cloud-functions 等无关内容。

## Dockerfile 要点

1. **两份 Prisma 客户端必须在镜像内生成**：`packages/db/src/index.ts` 静态导入 mysql + sqlite 两份，
   缺任一份 Next 打包即报 `Module not found: '../generated/sqlite'`。两个 Dockerfile 都跑了
   `generate:mysql && generate:sqlite`，与 `task db:generate` 一致。
2. **依赖用 `bun install --frozen-lockfile`**：`bun.lock` 是 TS 侧唯一锁文件（v1 不引入 npm lock，ADR-0001）。
   bun 只用于安装与跑构建脚本；admin 运行时仍是 Node 22（ADR-0013）。
3. **worker 必须带 ffmpeg/ffprobe**：worker 启动即自检，缺任一直接 `exit 1`。
   `shaka-packager` / `bento4` 是 CENC 演进项，镜像不装（自检里显示 MISSING 但不阻断）。
4. **worker 必须带水印字体 `fonts-noto-cjk`**（2026-10-05，spec.md §10.6）：文字水印的
   `drawtext fontfile` 取镜像内 `/usr/share/fonts/opentype/noto/NotoSans{,Bold}-CJK-Regular.ttc`
   与 `NotoSerifCJK-Regular.ttc`（键 → 文件映射见 `@openvod/transcode` 的 `WATERMARK_FONT_FILES`）。
   Dockerfile 在**构建期** `test -f` 三份字体（缺则构建失败），Worker 启动时再自检一次并**告警不退出**——
   因为 `drawtext` 的 `fontfile` 不存在时 ffmpeg 不报错而是静默回退系统默认字体，中文会渲染成豆腐块而任务仍报成功。
   自建镜像若裁掉了字体，必须同步改 `WATERMARK_FONT_DIR`（`@openvod/shared`）与映射。
4. **admin 镜像的构建与运行阶段都必须装 openssl**（2026-09-22 实测踩坑）：Prisma 生成客户端时按检测到的
   libssl 选择查询引擎——构建阶段缺 openssl 会退化为 `debian-openssl-1.1.x`，与运行阶段（bookworm libssl3）
   不匹配，启动报 `generated for "debian-openssl-1.1.x", but the actual deployment required "debian-openssl-3.0.x"`，
   `/healthz` 变 `db:false`。两阶段都装 openssl 即对齐（worker 基于 Debian 全量环境，无此问题）。
5. **player 镜像不需要 Prisma / openssl，也不接受构建期地址内联**（2026-10-13，spec.md §11.8）：
   player 不 import `packages/db` → Dockerfile 省去两份客户端生成（对比第 1 条）；浏览器直连分发端地址
   由**运行时** env 下发（`/api/session` 响应 `delivery_base`：`PLAYER_PUBLIC_DELIVERY_BASE_URL` →
   `NEXT_PUBLIC_DELIVERY_BASE_URL` → `DELIVERY_BASE_URL` → 默认），镜像一次构建跨环境部署、改 env 即生效。
   容器内服务端地址（容器网络视角）与浏览器视角地址不同时必须分别配置——`127.0.0.1` 在容器内指容器自身。

## 运行

**推荐走 compose（三服务一份编排，见下节）**；下面是单容器调试的等价 `docker run`：

```bash
# admin：UI + API 同源（无 CORS）；端口由 ADMIN_PORT 控制，默认 8787
docker run -d --name openvod-admin -p 8787:8787 --env-file .env openvod-admin:latest

# worker（resident 默认）：无端口；转码临时目录在 os.tmpdir()，必须挂大磁盘（ADR-0003）
docker run -d --name openvod-worker --env-file .env \
  -v /data/openvod-tmp:/tmp openvod-worker:latest

# worker（http 门铃模式，ADR-0017）：暴露 /wake 与 /healthz；WORKER_NOTIFY_SECRET 必填
docker run -d --name openvod-worker -p 9001:9001 --env-file .env \
  -e WORKER_MODE=http -e WORKER_NOTIFY_SECRET=<至少16字符> \
  -v /data/openvod-tmp:/tmp openvod-worker:latest

# player（播放演示 App，spec.md §11）：免登录；依赖分发端可达 + 预览账号（PLAYER_PREVIEW_* / 回退 DELIVERY_PREVIEW_*）
# 容器内服务端地址用 .env 的 DELIVERY_BASE_URL；浏览器直连地址用 PLAYER_PUBLIC_DELIVERY_BASE_URL（容器内 127.0.0.1 不是宿主）
docker run -d --name openvod-player -p 3100:3100 --env-file .env \
  -e PLAYER_PUBLIC_DELIVERY_BASE_URL=http://<浏览器可达的分发端地址> openvod-player:latest
```

接通验证：admin `curl -fsS localhost:8787/healthz` 返回 `{"ok":true,"db":true}`；
resident worker 日志出现 `[worker] ffmpeg ok` / `[worker] ffprobe ok` / `[worker] 字体 ok` 与 `polling every ...`；
（`字体 MISSING` 不阻断启动，但用到文字水印的模板会渲染成豆腐块，见上文第 4 条）
http 模式为 `http 门铃模式 listening :9001`，且 `curl -fsS localhost:9001/healthz` 返回 200。
player `curl -fsS localhost:3100/healthz` 返回 `{"ok":true,"app":"player"}`，浏览器打开列表能出封面即链路通；
若未配置预览账号，页面会给出配置说明（`/api/session` 501）。

## Compose 运行（单机常驻，CNB / 任意 Docker 宿主）

根目录 [docker-compose.yml](../../docker-compose.yml) 交付 ADR-0011 的「同宿主并用一份编排」形态：
admin + worker + player 三个常驻服务，**镜像预先构建**、运行侧只 `pull + up`，不在宿主构建。

| 服务 | 镜像（默认） | 预构建入口 |
|---|---|---|
| admin | `docker.cnb.cool/arsrna/media/openvod/admin:latest` | CNB「构建admin（Docker）」按钮；或本地 `task image:admin` |
| worker | `docker.cnb.cool/arsrna/media/openvod/worker:latest` | CNB「构建worker（Docker）」按钮；或本地 `task image:worker` |
| player | `docker.cnb.cool/arsrna/media/openvod/player:latest` | CNB「构建player（Docker）」按钮；或本地 `task image:player` |

（镜像地址可用 `OPENVOD_ADMIN_IMAGE` / `OPENVOD_WORKER_IMAGE` / `OPENVOD_PLAYER_IMAGE` 覆盖。）

```bash
scripts/compose.sh up            # = 先加载 .env → docker compose pull（失败降级为警告）→ up -d
scripts/compose.sh ps | logs [服务] | restart [服务] | down | url
```

首次部署注意：**先构建镜像再 up**——CNB 上点「构建admin（Docker）」/「构建worker（Docker）」/「构建player（Docker）」按钮；若制品库尚无该镜像，
脚本会打印警告并回退到**本地同名镜像**（如已 `task image:admin` / `task image:worker` / `task image:player` 构建过）。
脚本会先 `set -a; . .env` 再调 compose：compose 的插值以 shell 环境变量优先于 `.env` 文件，不加载会出现
「宿主 shell 残留旧 ADMIN_PORT → 映射端口与容器内端口不一致」。改了 `.env` 端口后请 `down && up` 重建容器。

CNB 云原生开发环境实测要点（2026-09-22）：

- **端口预览可用**：容器端口发布绑定在开发容器 `0.0.0.0`（WebIDE 端口映射的前提），管理端访问地址 =
  `CNB_VSCODE_PROXY_URI` 把 `{{port}}` 换为 `ADMIN_PORT`（`scripts/compose.sh url` 直接打印）；
  player 同理把 `{{port}}` 换为 `PLAYER_PORT`（`compose.sh up` 会一并打印）。
- **`CNB_VSCODE_PROXY_URI` 必须显式透传**（compose 已注入 admin 服务）：容器不继承宿主环境变量，
  而 `apps/admin/src/lib/auth.ts` 据它推导 better-auth 的 baseURL 与 trustedOrigins——不传会出现登录
  403 `Invalid origin`（见 dev-workflow §8 对应排查条目）。
- **数据库**：容器直连 `.env` 的 `DATABASE_URL`（CNB 环境为公网 TDSQL-C，容器内 DNS/TCP 已实测可达）。
  注意容器内 `127.0.0.1` 指容器自身——`DELIVERY_BASE_URL` / `DELIVERY_DATABASE_URL` 等指向宿主机服务的地址
  必须改成实际可达地址。
- **worker 大磁盘**：容器 `/tmp` 挂到 `.run/worker-tmp`（默认；可用 `OPENVOD_WORKER_TMP` 改路径）。
- 云原生开发环境重启后 rootless docker 的容器 / 镜像不保证保留：重开环境执行一次 `scripts/compose.sh up`
  即可（制品库在内网，pull 很快）。
- delivery 不在此编排内——按 ADR-0003 部署到 EdgeOne Cloud Functions / SCF。

### 硬约束

- **worker 只能单实例**（v1）：同一媒资的任务必须串行，加密任务尤其如此——两个任务各自
  `generateMediaKey` 会产出两把不同 CEK，只有最后落库的那把能解密，另一套产物永久不可解
  （ADR-0006 §4.2）。多实例横向扩展属演进项。
- **worker 禁止上任何函数**（P0，ADR-0003/0008）：镜像体积、执行时长、可写层三重撞墙。
- 两进程共享一库一桶；**迁移只能由 `packages/db` 执行**，且必须 expand-contract 向后兼容（ADR-0011 约束 1）。
- admin 需要 `DATABASE_URL` / `DB_PROVIDER` / `BETTER_AUTH_SECRET` 等（env 域 `shared` + `admin`）；
  worker 需要 `DATABASE_URL` / `MASTER_KEYS` / `STORAGE_*`（env 域 `shared` + `worker`）。域划分见 spec.md 附录。
- player 需要 `DELIVERY_BASE_URL`（容器内可达）+ 预览账号（`PLAYER_PREVIEW_*` / 回退 `DELIVERY_PREVIEW_*`）；
  浏览器直连地址 `PLAYER_PUBLIC_DELIVERY_BASE_URL` 留空时回退 `DELIVERY_BASE_URL`——**容器内 `127.0.0.1`
  不是宿主**，两者视角不同时必须分别配置（spec.md §11.8）。

## CNB 一键构建

| 按钮 | 事件键 | 产物 |
|---|---|---|
| 构建admin（Docker） | `web_trigger_admin_docker` | `${CNB_DOCKER_REGISTRY}/${CNB_REPO_SLUG_LOWERCASE}/admin:latest` |
| 构建worker（Docker） | `web_trigger_worker_docker` | `${CNB_DOCKER_REGISTRY}/${CNB_REPO_SLUG_LOWERCASE}/worker:latest` |
| 构建player（Docker） | `web_trigger_player_docker` | `${CNB_DOCKER_REGISTRY}/${CNB_REPO_SLUG_LOWERCASE}/player:latest` |
| 发布播放器SDK | `web_trigger_publish_sdk` | `openvod-jssdk` → npm 官方 + CNB npm 制品库（单测覆盖率上报 CNB 洞察） |
| 打 tag 发版（worker + admin + delivery + player 一次构建） | `tag_push` | 四个镜像均推 `:latest` 与 `:<tag名>` 双标签（delivery 构建见 deploy-delivery.md）；**同批发布播放器 SDK** |

`tag_push` 流水线（`$` 兜底分支）单流水线串行构建四个运行镜像，任一 stage 失败即中断、
不留「半个版本」；产物同时保留 `:latest` 与本次 tag 两个标签，制品库可直接按 tag 回滚。

### 发版链路（2026-10-16 起：含播放器 SDK）

1. 升级**根 `package.json` 的 version**（全仓库唯一版本号，子包一律不声明），并合入**默认分支**（当前 `main`，
   见下条的分支来源）；
2. Tag 列表页「自动生成 Tag」→ `auto_tag` 读取根 `package.json` 的 version 校验语义化 → 确认同名 tag 不存在 →
   `git tag -a <version>` 并推送（tag 名即版本号，不带 `v` 前缀）。
   **配置挂载位置**：CNB 按**分支名**匹配 `auto_tag` 的流水线配置，写在 `$` 兜底里会被忽略——那时平台退化为
   内置 `cnbcool/git-auto-tag` 插件，按提交语义（`feat` → minor、`fix`/`docs` → patch）推导版本，与根
   `package.json` 漂移（2026-10-16 实测：`main` 上 version=1.1.0 时插件打出了 0.3.0）。因此本仓库的 auto_tag 任务
   定义在 `.cnb.yml` 顶部的 `.auto-tag` 锚点、由文件末尾的 **`main:` 段**引用；
   **运行 / 检出分支**由 CNB「Tag 自动生成配置」决定：默认分支下的 `.cnb/settings.yml` → `tag.auto_tag.branch`
   （默认值 = 仓库默认分支 `main`；本仓库未配置该文件），Tag 列表页按钮**不能临时选分支**，检出内容为该分支最新 commit。
   **Git LFS 注意**：本仓库用 LFS 追踪 `videos/mv.mp4`（`.gitattributes`），CNB 检出会带 `git-lfs` 的 `pre-push` 钩子——
   缺 `git-lfs` 的镜像会在推送 tag 时直接失败（`git-lfs was not found`）。故该 job 使用开发镜像（内置 `git-lfs` 3.4.1），
   并保留 `--no-verify` 兜底重试一次（推 tag 不涉及 LFS 对象，安全）；
3. tag 推送触发 `tag_push`：四个运行镜像（worker → admin → delivery → player）串行构建 + **独立 job**
   发布播放器 SDK——单测覆盖率（`testing:coverage`，红线见 `.cnb.yml`）→ `bun packages/player-sdk/scripts/publish.ts --registry both`
   发布到 npm 官方与 CNB 制品库；
4. SDK 版本与 tag 同源：发布脚本读取同一个根 `package.json` 的 version，并校验 `CNB_BRANCH`（tag 名）与之一致，
   不一致直接拒绝发布（防「tag 与内容不匹配」的错版）；
5. 令牌：`NPM_TOKEN` 由密钥仓库 `arsrna/env` 的 `npm.yml` 注入；CNB 制品库用内置 `CNB_TOKEN`，
   地址在 `.cnb.yml` 的 `CNB_NPM_REGISTRY`（见 [player-sdk-spec.md §12.5](./player-sdk-spec.md)）。
   仅需补发 SDK 时用「发布播放器SDK」按钮，或在本地跑 `bun run --cwd packages/player-sdk publish:{npm,cnb,both}`。

## 待办与待验证

- ~~compose 示例未交付~~ **已交付**（2026-09-22）：根 `docker-compose.yml` + `scripts/compose.sh`（admin + worker
  预构建镜像编排），已在 CNB 云原生开发环境实测（端口预览、大磁盘挂载、公网 DB 连通、worker 正常轮询）。
- **镜像架构**：流水线跑在 amd64 构建机上，产出 amd64 镜像；Prisma 引擎二进制也是按构建架构下载的，
  换 arm64 构建机时需要改为 `docker buildx build --platform linux/amd64`，否则引擎与运行时架构不匹配。
- **admin 构建期无需 env**（实测 `next build` 通过，页面为 `ƒ Dynamic` / 两个静态页），
  但运行时必须有 DB 与 `BETTER_AUTH_SECRET`，否则 `/healthz` 报 `db:false`。
- **player 镜像已实测**（2026-10-13）：`task image:player` 本地构建通过；`docker run --network host --env-file .env`
  启动后 `/healthz` 200、`/api/session` 正常换 JWT（响应带 `delivery_base`）、浏览器列表与播放页链路通
  （容器内即生产构建 `next start`）。浏览器直连地址运行时下发：改 env 重启即生效，无需重建镜像。
- **`docker run --env-file` 不剥引号**（2026-10-13 实测；compose 的 `env_file` 会剥、shell 的 `. .env` 会剥）：
  `.env` 里 `KEY="v"` 经 `docker run` 注入后值含引号——URL 会解析失败、`PLAYER_PORT` 让 `next start -p` 直接退出。
  player 已做剥离防御（`apps/player/src/lib/env.ts` + 镜像 CMD/HEALTHCHECK 只保留数字）；
  **admin / worker 未做**——单容器 `docker run` 调试时对 URL / 端口类键改用不带引号的 `-e KEY=value` 覆盖，或走 compose。
- **worker 镜像内 ffmpeg 版本**来自 Debian bookworm（5.1）；转码链路用的是标准 HLS muxer 参数
  （`-hls_time` / `-hls_playlist_type vod` / `-hls_key_info_file`），版本兼容，但首次上线建议跑一次真实转码回归。
