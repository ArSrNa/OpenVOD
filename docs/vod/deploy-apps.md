# 管理端与 Worker 镜像

管理侧是**一个应用、两个进程**（ADR-0011：「两应用 + N 进程」）：admin 与 worker 各自一个容器，
同宿主并用一份编排（compose 示例属 ADR-0011 未交付项，见文末）。分发端是完全分开的另一个应用，
其部署见 [deploy-delivery.md](./deploy-delivery.md)。

| 镜像 | Dockerfile | 运行时 | 端口 |
|---|---|---|---|
| `admin` | `apps/admin/Dockerfile` | Node 22（`next start`） | `:8787` · `GET /healthz` |
| `worker` | `apps/worker/Dockerfile` | Bun 常驻 | 无端口（轮询认领 `transcode_jobs`） |

## 构建上下文必须是仓库根

两个 app 都经 `workspace:*` 依赖 `packages/{db,shared,crypto,storage,transcode,contracts}`，
而且 admin 走 `transpilePackages` 直接消费这些包的 **TS 源码**。所以上下文是仓库根、用 `-f` 指 Dockerfile：

```bash
task image:admin      # docker build -f apps/admin/Dockerfile -t openvod-admin:latest .
task image:worker     # docker build -f apps/worker/Dockerfile -t openvod-worker:latest .
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
4. **admin 镜像的构建与运行阶段都必须装 openssl**（2026-09-22 实测踩坑）：Prisma 生成客户端时按检测到的
   libssl 选择查询引擎——构建阶段缺 openssl 会退化为 `debian-openssl-1.1.x`，与运行阶段（bookworm libssl3）
   不匹配，启动报 `generated for "debian-openssl-1.1.x", but the actual deployment required "debian-openssl-3.0.x"`，
   `/healthz` 变 `db:false`。两阶段都装 openssl 即对齐（worker 基于 Debian 全量环境，无此问题）。

## 运行

**推荐走 compose（两服务一份编排，见下节）**；下面是单容器调试的等价 `docker run`：

```bash
# admin：UI + API 同源（无 CORS）；端口由 ADMIN_PORT 控制，默认 8787
docker run -d --name openvod-admin -p 8787:8787 --env-file .env openvod-admin:latest

# worker：无端口；转码临时目录在 os.tmpdir()，必须挂大磁盘（ADR-0003）
docker run -d --name openvod-worker --env-file .env \
  -v /data/openvod-tmp:/tmp openvod-worker:latest
```

接通验证：admin `curl -fsS localhost:8787/healthz` 返回 `{"ok":true,"db":true}`；
worker 日志出现 `[worker] ffmpeg ok` / `[worker] ffprobe ok` 与 `polling every ...`。

## Compose 运行（单机常驻，CNB / 任意 Docker 宿主）

根目录 [docker-compose.yml](../../docker-compose.yml) 交付 ADR-0011 的「同宿主并用一份编排」形态：
admin + worker 两个常驻服务，**镜像预先构建**、运行侧只 `pull + up`，不在宿主构建。

| 服务 | 镜像（默认） | 预构建入口 |
|---|---|---|
| admin | `docker.cnb.cool/arsrna/media/openvod/admin:latest` | CNB「构建admin（Docker）」按钮；或本地 `task image:admin` |
| worker | `docker.cnb.cool/arsrna/media/openvod/worker:latest` | CNB「构建worker（Docker）」按钮；或本地 `task image:worker` |

（镜像地址可用 `OPENVOD_ADMIN_IMAGE` / `OPENVOD_WORKER_IMAGE` 覆盖。）

```bash
scripts/compose.sh up            # = 先加载 .env → docker compose pull（失败降级为警告）→ up -d
scripts/compose.sh ps | logs [服务] | restart [服务] | down | url
```

首次部署注意：**先构建镜像再 up**——CNB 上点「构建admin（Docker）」/「构建worker（Docker）」按钮；若制品库尚无该镜像，
脚本会打印警告并回退到**本地同名镜像**（如已 `task image:admin` / `task image:worker` 构建过）。
脚本会先 `set -a; . .env` 再调 compose：compose 的插值以 shell 环境变量优先于 `.env` 文件，不加载会出现
「宿主 shell 残留旧 ADMIN_PORT → 映射端口与容器内端口不一致」。改了 `.env` 端口后请 `down && up` 重建容器。

CNB 云原生开发环境实测要点（2026-09-22）：

- **端口预览可用**：容器端口发布绑定在开发容器 `0.0.0.0`（WebIDE 端口映射的前提），管理端访问地址 =
  `CNB_VSCODE_PROXY_URI` 把 `{{port}}` 换为 `ADMIN_PORT`（`scripts/compose.sh url` 直接打印）。
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

## CNB 一键构建

| 按钮 | 事件键 | 产物 |
|---|---|---|
| 构建admin（Docker） | `web_trigger_admin_docker` | `${CNB_DOCKER_REGISTRY}/${CNB_REPO_SLUG_LOWERCASE}/admin:latest` |
| 构建worker（Docker） | `web_trigger_worker_docker` | `${CNB_DOCKER_REGISTRY}/${CNB_REPO_SLUG_LOWERCASE}/worker:latest` |

## 待办与待验证

- ~~compose 示例未交付~~ **已交付**（2026-09-22）：根 `docker-compose.yml` + `scripts/compose.sh`（admin + worker
  预构建镜像编排），已在 CNB 云原生开发环境实测（端口预览、大磁盘挂载、公网 DB 连通、worker 正常轮询）。
- **镜像架构**：流水线跑在 amd64 构建机上，产出 amd64 镜像；Prisma 引擎二进制也是按构建架构下载的，
  换 arm64 构建机时需要改为 `docker buildx build --platform linux/amd64`，否则引擎与运行时架构不匹配。
- **admin 构建期无需 env**（实测 `next build` 通过，页面为 `ƒ Dynamic` / 两个静态页），
  但运行时必须有 DB 与 `BETTER_AUTH_SECRET`，否则 `/healthz` 报 `db:false`。
- **worker 镜像内 ffmpeg 版本**来自 Debian bookworm（5.1）；转码链路用的是标准 HLS muxer 参数
  （`-hls_time` / `-hls_playlist_type vod` / `-hls_key_info_file`），版本兼容，但首次上线建议跑一次真实转码回归。
