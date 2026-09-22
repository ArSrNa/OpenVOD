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

## Dockerfile 的三个要点

1. **两份 Prisma 客户端必须在镜像内生成**：`packages/db/src/index.ts` 静态导入 mysql + sqlite 两份，
   缺任一份 Next 打包即报 `Module not found: '../generated/sqlite'`。两个 Dockerfile 都跑了
   `generate:mysql && generate:sqlite`，与 `task db:generate` 一致。
2. **依赖用 `bun install --frozen-lockfile`**：`bun.lock` 是 TS 侧唯一锁文件（v1 不引入 npm lock，ADR-0001）。
   bun 只用于安装与跑构建脚本；admin 运行时仍是 Node 22（ADR-0013）。
3. **worker 必须带 ffmpeg/ffprobe**：worker 启动即自检，缺任一直接 `exit 1`。
   `shaka-packager` / `bento4` 是 CENC 演进项，镜像不装（自检里显示 MISSING 但不阻断）。

## 运行

```bash
# admin：UI + API 同源（无 CORS）；端口由 ADMIN_PORT 控制，默认 8787
docker run -d --name openvod-admin -p 8787:8787 --env-file .env openvod-admin:latest

# worker：无端口；转码临时目录在 os.tmpdir()，必须挂大磁盘（ADR-0003）
docker run -d --name openvod-worker --env-file .env \
  -v /data/openvod-tmp:/tmp openvod-worker:latest
```

接通验证：admin `curl -fsS localhost:8787/healthz` 返回 `{"ok":true,"db":true}`；
worker 日志出现 `[worker] ffmpeg ok` / `[worker] ffprobe ok` 与 `polling every ...`。

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

- **compose 示例未交付**（ADR-0011 交付物之一），目前只有单容器构建与运行命令。
- **镜像架构**：流水线跑在 amd64 构建机上，产出 amd64 镜像；Prisma 引擎二进制也是按构建架构下载的，
  换 arm64 构建机时需要改为 `docker buildx build --platform linux/amd64`，否则引擎与运行时架构不匹配。
- **admin 构建期无需 env**（实测 `next build` 通过，页面为 `ƒ Dynamic` / 两个静态页），
  但运行时必须有 DB 与 `BETTER_AUTH_SECRET`，否则 `/healthz` 报 `db:false`。
- **worker 镜像内 ffmpeg 版本**来自 Debian bookworm（5.1）；转码链路用的是标准 HLS muxer 参数
  （`-hls_time` / `-hls_playlist_type vod` / `-hls_key_info_file`），版本兼容，但首次上线建议跑一次真实转码回归。
