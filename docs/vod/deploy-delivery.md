# 分发端（delivery）部署

分发端是**同一份 Go 代码的两个同级目标**（ADR-0003）：SCF 容器与 EdgeOne Cloud Functions。
两边的装配逻辑单点维护在 `apps/delivery/app`，两个入口都只是 `app.Run()` 的薄包装：

| 目标 | 入口 | 形态 |
|---|---|---|
| SCF Web 函数（容器） | `apps/delivery/main.go` | Dockerfile 静态二进制（distroless），监听 `:9000` |
| EdgeOne Cloud Functions | `cloud-functions/index.go` | Go Framework 模式，平台交叉编译后监听 `:9000` |

因此**改装配逻辑只改 `apps/delivery/app/app.go`**；两个入口文件不要各自加逻辑，否则目标间必然漂移。

## 目标 A：SCF 容器（Docker）

```bash
task image:delivery     # docker buildx build --platform linux/amd64（SCF 仅 x86）
# 推同地域 TCR 私有仓库 → SCF 更新函数（镜像 + 环境变量）
```

无内网依赖，DB 可走 VPC 或公网；容器形态下 `STORAGE_DRIVER=local` 亦可用（挂 CFS 卷）。

## 目标 B：EdgeOne Makers Cloud Functions

> Pages 已更名 **EdgeOne Makers**，CLI 用 `edgeone makers <cmd>`（`edgeone pages` 过渡期等价）。

### 项目设置

- **根目录** = 仓库根（`cloud-functions/` 必须在项目根下，平台不支持改这个目录名）；
- **入口文件名必须是 `index.go`**：平台按文件名生成 URL 前缀，`index.go` → `/`，`api.go` → `/api`。
  delivery 暴露 `/healthz` 与 `/v1/...`，改名会让整站多一层前缀、播放链路全 404；
- `edgeone.json` 已就位：`installCommand` / `buildCommand` 置为 no-op（本仓库 TS 侧由 CNB 构建，
  EdgeOne 侧只需要 Go 函数），`outputDirectory` 指向空的 `public/`（**不要留空**——默认根目录会把整个 monorepo 当静态资源发布）。

### 环境变量（delivery 域，生产环境）

| 变量 | 说明 |
|---|---|
| `DELIVERY_DATABASE_URL` | **必须公网可达 + TLS**：Cloud Functions 无 VPC（ADR-0003 P0 结论）。`ParseDatabaseURL` 不做 TLS 兜底，公网库要自带 `?tls=true`（或自签场景 `tls=skip-verify`）。账号用 ADR-0011 的受限只读账号 |
| `DELIVERY_PUBLIC_BASE_URL` | 最终分发域名（清单 / 密钥 / 字幕 URL 基址）；运行时可被 `system_settings.playback_base_url` 覆盖 |
| `URL_SIGN_KEY_HEX` / `MASTER_KEYS` | 必填。**环境变量值上限 500 字节**，MK 轮换保留旧版本时注意总量 |
| `STORAGE_DRIVER=s3` + `S3_ENDPOINT` / `S3_REGION` / `S3_BUCKET` / `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY`（+ `S3_FORCE_PATH_STYLE=false`、可选 `STORAGE_CDN_BASE_URL`） | **函数形态不能用 `local` 驱动**：无共享卷，且 `/v1/media/{id}/segment/*` 流式代理会撞 6MB 响应体上限。s3 形态走预签名直出，字节不经过函数 |
| `DELIVERY_CORS_ORIGINS` | 默认 `*`；收敛为管理端源站即可 |
| `APP_ENV` / `DELIVERY_JWT_*` / `PLAYBACK_*_TTL_SEC` | 按需覆盖默认值。`DELIVERY_LISTEN` 保持默认 `:9000` |

### 平台限制对照

| 项 | 限制 | 对本项目的影响 |
|---|---|---|
| 执行时长 | 默认 30s，最大 120s | `edgeone.json` 已设 `cloudFunctions.go.maxDuration=120` |
| 请求 / 响应 body | ≤6MB | 分片走 S3 预签名直出，不受影响；禁止新增函数侧流式代理 |
| 代码包 | ≤128MB（含依赖） | 静态二进制约 17MB |
| 转码 | — | P0：转码永不上函数（delivery 本就不转码） |

### 部署

```bash
# 本地 / CI 手动部署（无需 Git 集成）
npx edgeone makers deploy -n <project> -t $EDGEONE_API_TOKEN

# 或 Git 集成：push 到生产分支自动构建部署
```

合并前门禁用 `task build:edgeone`（与平台同款 GOOS/GOARCH 交叉编译）。

## CNB 一键构建（web_trigger 按钮）

分支详情页有三个按钮，`.cnb/web_trigger.yml` 的 `event` 与 `.cnb.yml` 中 `$` 下的 `web_trigger_*` 键同名对应：

| 按钮 | 事件键 | 动作 |
|---|---|---|
| 构建开发环境镜像 | `web_trigger_dev_image` | `buildx` 构建并推送 `.ide/Dockerfile` |
| **构建delivery（Docker）** | `web_trigger_delivery_docker` | `cd apps/delivery && docker build` → `docker push` `${CNB_DOCKER_REGISTRY}/${CNB_REPO_SLUG_LOWERCASE}/delivery:latest` |
| **构建delivery（Edgeone）** | `web_trigger_delivery_edgeone` | `task build:edgeone` 门禁 → `npx edgeone@latest makers deploy` |

两处容易踩的点：

- **Docker 构建的上下文必须是 `apps/delivery`**（Dockerfile 的 `COPY go.mod go.sum* ./` 相对该目录）。
  用仓库根作上下文会找不到 `go.mod`——所以脚本里先 `cd apps/delivery`，不能用 `docker build ... .` 直接打仓库根。
- **架构**：SCF 仅接受 x86。流水线用的是默认 amd64 构建机，`docker build` 产出的就是 amd64；
  若换到 arm64 构建机，改用 `docker buildx build --platform linux/amd64 --push`（`.cnb.yml` 里已留注释）。

EdgeOne 按钮的两个变量**值先留空**，正式值走 CNB 密钥仓库 `imports`（与现有 `env.dev.yml` 同机制）或平台环境变量，不要写进仓库：

| 变量 | 说明 |
|---|---|
| `EDGEONE_PROJECT` | Makers 控制台的项目名 |
| `EDGEONE_API_TOKEN` | Makers 控制台生成的 API Token |

## 平台实测结论（2026-09-22 首次部署）

| 假设 | 实测结论 |
|---|---|
| 构建是否**原地**编译 | **否**。Go builder 把 `cloud-functions/` 拷到隔离目录后再 `go mod tidy` + `go build`（只带该目录内容）。`replace ../apps/delivery` 直接报 `replacement directory ../apps/delivery does not exist` |
| `installCommand` / `buildCommand` 置 no-op | 无影响：两条命令都按配置执行，之后 Go builder 正常启动；根 `package.json` 无 `build` 脚本也不会被误触发 |
| `outputDirectory: public` | 正常：静态产物走 `.edgeone/assets`，不会把 monorepo 当静态资源发布 |
| `edgeone.json` 字段 | 首次部署报三个 DEPRECATED，已迁移：`cloudFunctions.go.maxDuration` → `cloudFunctions.maxDuration`；`mainlandRegions` / `overseasRegions` → `cloudFunctions.regions.{mainland,overseas}` |

### 由此确定的布局：cloud-functions 必须自包含

因为构建在隔离目录进行，EdgeOne 侧需要的 Go 源码**必须全部位于 `cloud-functions/` 内部**。
`internal` 规则 + 单点维护源码这两条约束下，做法是构建前把 `apps/delivery` 同步进去：

```bash
task edgeone:prepare     # apps/delivery → cloud-functions/openvod/apps/delivery（生成物，.gitignore 忽略）
```

`cloud-functions/go.mod` 的 `replace openvod/apps/delivery => ./openvod/apps/delivery` 指向该副本，
所以**本地或 CI 里直接 `edgeone makers deploy` 之前必须先跑 `edgeone:prepare`**。
`task build:edgeone` 已把它设为 `deps`（CNB 按钮里的门禁 stage 就是这个 task，同一 job 内产物延续到 deploy stage）。

> **推论：不要给 Makers 项目配 Git 自动部署。** 副本是生成物、不入库，Makers 拉 Git 仓库构建时
> `cloud-functions/openvod/` 不存在，必然复现 `replacement directory ... does not exist`。
> 发布入口统一走 CNB 的 edgeone 按钮（或任何先执行 `task edgeone:prepare` 的流水线）。

### 仍未验证

**`no-store` 在边缘的行为**。函数响应正常不应被缓存，但 P0 纪律要求以真实域名验证：
清单与密钥响应必须 `Cache-Control: no-store` 且不进任何边缘缓存（对应 CI 门禁 `assert-no-store`）；
同时用无签名请求打加速域名，断言 403（`assert-unsigned-403`）。

### 另一个部署前置：函数环境变量

`edgeone makers deploy` 会从控制台拉取环境变量（首次部署日志里的 `No environment variables found`）。
delivery 运行所需的 `DELIVERY_DATABASE_URL` / `DELIVERY_PUBLIC_BASE_URL` / `URL_SIGN_KEY_HEX` /
`MASTER_KEYS` / `STORAGE_DRIVER` + `S3_*` 等，必须在 **Makers 控制台按环境（生产 / 预览）配置**，
否则函数实例启动即 `config` 校验失败。
