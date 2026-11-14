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
`http`（serverless 门铃）/ `invoked`（异步云函数，ADR-0017 §6）监听 `WORKER_HTTP_PORT`（默认 `9001`）：
`POST /wake` 触发认领（Bearer `WORKER_NOTIFY_SECRET`；载荷 `{job_ids}` 只被 `invoked` 消费，定向认领不扫队列），
`GET /healthz` 供平台探活。镜像与 compose 均已内置模式感知 HEALTHCHECK（http / invoked 探 /healthz；resident 看进程）。

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
   **admin 同样需要 ffprobe**（元数据 / 水印图片探测，见下方第 6 条），但只告警不阻断启动。
4. **worker 必须带水印字体 `fonts-noto-cjk`**（2026-10-05，spec.md §10.6）：文字水印的
   `drawtext fontfile` 取镜像内 `/usr/share/fonts/opentype/noto/NotoSans{,Bold}-CJK-Regular.ttc`
   与 `NotoSerifCJK-Regular.ttc`（键 → 文件映射见 `@openvod/transcode` 的 `WATERMARK_FONT_FILES`）。
   Dockerfile 在**构建期** `test -f` 三份字体（缺则构建失败），Worker 启动时再自检一次并**告警不退出**——
   因为 `drawtext` 的 `fontfile` 不存在时 ffmpeg 不报错而是静默回退系统默认字体，中文会渲染成豆腐块而任务仍报成功。
   自建镜像若裁掉了字体，必须同步改 `WATERMARK_FONT_DIR`（`@openvod/shared`）与映射。
5. **admin 镜像不再需要 openssl**（ADR-0020，2026-11-14）：Prisma 7 去掉了 Rust 查询引擎，
   改由 `mariadb` / `libsql` 驱动连接，镜像只留 `ca-certificates`（供 HTTPS 校验）。
   2026-09-22 那条「构建与运行阶段都装 openssl 对齐 libssl」的坑随引擎一起消失，不要再加回来。
6. **admin 运行时必须带 ffmpeg（ffprobe）**（2026-11-13）：管理端「生成元数据」（spec.md §2.1）与
   「水印图片宽高探测」（spec.md §10.2）都在 **admin 进程内**就地跑 `ffprobe`，镜像里没有就整条功能 500
   「运行环境无法执行 ffprobe」。`apps/admin/Dockerfile` 在 **runtime 阶段** `apt-get install ffmpeg`，
   并在构建期 `ffprobe -version` 自检（缺则构建失败）；构建阶段不需要——`next build` 不探测。
   自建 / 裁剪镜像时要保留 ffprobe，否则上传水印图会退化为「无法解析图片尺寸」。
7. **player 镜像不需要 Prisma / openssl，也不接受构建期地址内联**（2026-10-13，spec.md §11.8）：
   player 不 import `packages/db` → Dockerfile 省去两份客户端生成（对比第 1 条）；**2026-11-12 起**浏览器不再直连分发端
   （spec.md §11.9：`/api/delivery/**` 同源代理），只需在服务端配 `DELIVERY_BASE_URL`（容器网络视角）——
   镜像一次构建跨环境部署、改 env 即生效，且不必再对齐「浏览器视角地址」
   （原 `PLAYER_PUBLIC_DELIVERY_BASE_URL` 已退场）。容器内 `127.0.0.1` 指容器自身，指向宿主服务请用容器可达地址。

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

# worker（invoked 异步云函数模式，ADR-0017 §6）：仅当平台异步执行能覆盖整个任务时长时使用。
# 两条硬要求：① WORKER_JOBS_ROOT 指向挂载的文件系统（大内存 ≠ 大磁盘，/tmp 装不下产物峰值）；
# ② WORKER_IDLE_EXIT_MINUTES 设 1~5，任务跑完后进程主动退出，避免平台按进程存活继续计费。
docker run -d --name openvod-worker -p 9001:9001 --env-file .env \
  -e WORKER_MODE=invoked -e WORKER_NOTIFY_SECRET=<至少16字符> \
  -e WORKER_JOBS_ROOT=/mnt/openvod-jobs -e WORKER_IDLE_EXIT_MINUTES=3 \
  -v /mnt/cfs/openvod-jobs:/mnt/openvod-jobs openvod-worker:latest

# player（播放演示 App，spec.md §11）：免登录；依赖分发端可达 + 预览账号（PLAYER_PREVIEW_* / 回退 DELIVERY_PREVIEW_*）
# 只需服务端的 DELIVERY_BASE_URL（容器内可达）；浏览器请求经 /api/delivery 同源代理，无需浏览器视角地址（spec.md §11.9）
docker run -d --name openvod-player -p 3100:3100 --env-file .env \
  -e DELIVERY_BASE_URL=http://<容器内可达的分发端地址> openvod-player:latest
```

接通验证：admin `curl -fsS localhost:8787/healthz` 返回 `{"ok":true,"db":true}`，
且容器内 `docker compose exec admin ffprobe -version` 有版本输出（缺则「生成元数据」500，见要点第 6 条）；
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
  注意容器内 `127.0.0.1` 指容器自身——`DELIVERY_BASE_URL` / `DATABASE_URL` 等指向宿主机服务的地址
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
  浏览器请求一律经 `/api/delivery` 同源代理（spec.md §11.9），不再有「浏览器视角地址」——
  **容器内 `127.0.0.1` 不是宿主**，指向宿主服务请直接写在 `DELIVERY_BASE_URL` 里。

## CNB 一键构建

| 按钮 | 事件键 | 产物 |
|---|---|---|
| 构建admin（Docker） | `web_trigger_admin_docker` | `${CNB_DOCKER_REGISTRY}/${CNB_REPO_SLUG_LOWERCASE}/admin:latest` |
| 构建worker（Docker） | `web_trigger_worker_docker` | `${CNB_DOCKER_REGISTRY}/${CNB_REPO_SLUG_LOWERCASE}/worker:latest` |
| 构建worker（腾讯云CCR） | `web_trigger_worker_ccr` | `ccr.ccs.tencentyun.com/tcb-${CCR_UIN}-iydy/openvod:worker`（凭据取密钥仓库 `ccr.yaml`，见下） |
| 构建player（Docker） | `web_trigger_player_docker` | `${CNB_DOCKER_REGISTRY}/${CNB_REPO_SLUG_LOWERCASE}/player:latest` |
| 发布播放器SDK | `web_trigger_publish_sdk` | `openvod-jssdk` → npm 官方 + CNB npm 制品库（单测覆盖率上报 CNB 洞察） |
| 打 tag 发版（worker + admin + delivery + player 一次构建） | `tag_push` | 四个镜像均推 `:latest` 与 `:<tag名>` 双标签（delivery 构建见 deploy-delivery.md）；**同批发布播放器 SDK** |

`tag_push` 流水线（`$` 兜底分支）单流水线串行构建四个运行镜像，任一 stage 失败即中断、
不留「半个版本」；产物同时保留 `:latest` 与本次 tag 两个标签，制品库可直接按 tag 回滚。

### 同步到腾讯云 CCR（`web_trigger_worker_ccr`）

除 CNB 制品库外，worker 镜像还可另推一份到腾讯云**容器镜像服务 CCR**（`ccr.ccs.tencentyun.com`），
仓库地址 `tcb-${CCR_UIN}-iydy/openvod`，标签为 `:worker`。
实现见 `.cnb.yml` 的 `.push-worker-ccr` 锚点，一个 stage 内「登录 → 构建 → 推送」：
（admin 的 CCR 同步流水线已移除，admin 只推 CNB 制品库。）

```bash
# 凭据：密钥仓库 https://cnb.cool/arsrna/env/-/blob/main/ccr.yaml（CCR_UIN / CCR_PASSWORD）
# 登录：密码走 stdin，避免 -p 明文回显进流水线日志
printf '%s' "$CCR_PASSWORD" | docker login ccr.ccs.tencentyun.com --username "$CCR_UIN" --password-stdin

# 构建即推送，并在导出侧锁死 docker v2 schema2（仓库根上下文）
docker buildx build -f apps/worker/Dockerfile --platform linux/amd64 \
  --provenance=false --sbom=false \
  --output type=image,name=ccr.ccs.tencentyun.com/tcb-${CCR_UIN}-iydy/openvod:worker,oci-mediatypes=false,push=true .

# 断言远端确实是 schema2（不是 OCI），不满足直接失败
docker buildx imagetools inspect ccr.ccs.tencentyun.com/tcb-${CCR_UIN}-iydy/openvod:worker \
  --format '{{.Manifest.MediaType}}'   # 期望 application/vnd.docker.distribution.manifest.v2+json
```

worker 镜像含 `ffmpeg` 与 `fonts-noto-cjk`，层较大，首次推送耗时较长。

要点：

- **必须落成 docker v2 schema2，且只能靠导出侧参数**（2026-11-13 本机实测）：
  ①`--provenance=false` 关证明、`--sbom=false` 关附件，否则 `--push` 会多出一个 attestation manifest，
  整体变成 OCI index（`application/vnd.oci.image.index.v1+json`）；
  ②`oci-mediatypes=false` 让 manifest 媒体类型是 `application/vnd.docker.distribution.manifest.v2+json`。
  **`--output type=docker` + `docker push` 不能保证 schema2**：Docker 29 起默认使用 containerd 镜像存储
  （`Storage Driver: overlayfs` / `io.containerd.snapshotter.v1`），镜像以 OCI 形态存储、push 时不做
  schema2 转换——实测推上去的是 OCI index，CCR 控制台里就显示 `OCI-Image-v1`。
- **架构对齐腾讯云**：显式 `--platform linux/amd64`（TKE / SCF 均为 x86）；构建机若为 arm64 需 buildx + QEMU，
  否则直接报 `no match for platform`（宁可构建失败，也不要把 arm64 镜像推上去）。
- **命名空间 / 仓库要先存在**：CCR 控制台里没有 `tcb-<UIN>-iydy` 命名空间或 `openvod` 仓库时，
  `docker push` 会因无写权限失败；凭据用该账号的 UIN + 镜像仓库密码（不是 API 密钥）。
- 换仓库 / 项目名只改 `.cnb.yml` 里的 `IMAGE` 一行；凭据改动只改密钥仓库 `ccr.yaml`，不进仓库。

### 发版链路（2026-10-16 起：含播放器 SDK）

1. 升级**根 `package.json` 的 version**（全仓库唯一版本号，子包一律不声明），并合入**默认分支**（当前 `main`，
   见下条的分支来源）；
2. Tag 列表页「自动生成 Tag」→ `auto_tag` 打 tag，**tag 名 = 根 `package.json` 的 version**（不带 `v` 前缀）。
   实现见 `.cnb.yml` 顶部 `.auto-tag` 锚点，由文件末尾的 **`main:` 段**引用：读 `package.json` 的 version →
   校验远端没有同名 tag → `git tag -a` + `git push` → `git ls-remote` 复核。全程不经 `git-auto-tag` 插件，
   因此不会出现「插件按 feat/fix 推导出 0.3.0」的漂移。四个易踩的点：
   - **挂载位置必须是分支名（`main:`），不能写 `$` 兜底**：`auto_tag` 是平台「页面操作事件」，点按钮时平台先注入
     一条内置流水线（`cnbcool/git-auto-tag`，按提交语义推导版本）再与 `.cnb.yml` 合并；官方
     `build/trigger-rule.md`「配置覆盖规则」原文：**写在 `$` 下的 `auto_tag` 会被忽略**。本仓库两次在这条上翻车，
     都是把「生效的是内置插件」误读成「我们的 job 生效了」：
     - `cnb-s7p-1k51v01kf`（sha `6e982a2`，当时挂 `main:`）→ 日志里是本任务的 stage，内置插件的
       `docker run` 没有出现 ⇒ **同分支覆盖成立**；
     - `cnb-tp7-1k52fq5kb`（sha `f8f600a`，挂 `$`）与 `cnb-nuh-1k52f23cb`（sha `09de7a5`）→ 日志里只有
       `docker run cnbcool/git-auto-tag` 与**内置 job 特有的末尾那句 `echo $NEW_TAG`**，本任务的 stage
       一个都没出现 ⇒ `$` 下确实被忽略，version=1.1.0 被打成了 0.3.0。
     辨析「跑的是谁」看末尾有没有 `echo $NEW_TAG`：有 = 内置 job，没有 = 本任务；
   - **不要再用 `settings.tagFormat` 钉 tag 名**：那条路要求把版本号以**字符串字面量**嵌进
     `tagFormat`（`'${''$PKG_VERSION''}'`），依赖「settings 变量替换 + semantic-release 的 lodash 模板求值」
     两层隐式行为，且插件仍会按提交语义决定「是否发版」。既然 `main:` 下本任务会盖掉内置那条，直接自己打 tag
     更短、更确定；
   - **运行 / 检出分支**由 CNB「Tag 自动生成配置」决定：默认分支下的 `.cnb/settings.yml` → `tag.auto_tag.branch`
     （默认值 = 仓库默认分支 `main`；本仓库未配置该文件）；Tag 列表页按钮**不能临时选分支**，
     检出 = 该分支最新 commit ⇒ **发版前先把待发布提交合入 `main`**。若日后改发版源分支，`main:` 键名要同步改；
   - **Git LFS**：本仓库用 LFS 追踪 `videos/mv.mp4`（`.gitattributes`），CNB 检出会带 `git-lfs` 的 `pre-push`
     钩子。曾因镜像缺 `git-lfs` 直接 push 失败（`git-lfs was not found`）；现在 job 用开发镜像（内置 `git-lfs`），
     且推 tag 时显式 `--no-verify`——推 tag 只上传 tag 对象、不涉及任何 LFS 对象，跳过该钩子是安全的；
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
  启动后 `/healthz` 200、`/api/session` 正常换 JWT、浏览器列表与播放页链路通（容器内即生产构建 `next start`）。
  服务端地址改 env 重启即生效，无需重建镜像。
- **`docker run --env-file` 不剥引号**（2026-10-13 实测；compose 的 `env_file` 会剥、shell 的 `. .env` 会剥）：
  `.env` 里 `KEY="v"` 经 `docker run` 注入后值含引号——URL 会解析失败、`PLAYER_PORT` 让 `next start -p` 直接退出。
  player 已做剥离防御（`apps/player/src/lib/env.ts` + 镜像 CMD/HEALTHCHECK 只保留数字）；
  **admin / worker 未做**——单容器 `docker run` 调试时对 URL / 端口类键改用不带引号的 `-e KEY=value` 覆盖，或走 compose。
- **worker 镜像内 ffmpeg 版本**来自 Debian bookworm（5.1）；转码链路用的是标准 HLS muxer 参数
  （`-hls_time` / `-hls_playlist_type vod` / `-hls_key_info_file`），版本兼容，但首次上线建议跑一次真实转码回归。
