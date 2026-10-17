# ADR-0003：部署目标与发布流水线

- 状态：已接受（平台事实经官方文档核实，2026-09；含 P0 验证项）
- 日期：2026-09-17
- 修订：2026-09-22，EdgeOne Makers 固定 CLI、独立暂存项目、产物路由门禁与生产域名冒烟
- 关联：ADR-0002、ADR-0005、ADR-0006

## 背景

需求：「方便地部署在腾讯云 EdgeOne，或 Docker 到腾讯云云函数」。平台硬事实（官方文档，2026-09 核实）：

| 项 | EdgeOne Pages Cloud Functions | SCF Web 函数（容器） |
|---|---|---|
| 运行时 | Node 20 / Python 3.10 / **Go 1.26** | 任意容器（监听 9000 端口，30s 内启动） |
| 代码 / 镜像 | 代码包 ≤128MB | 镜像限制严格；仅同地域 TCR 私有仓库；**仅 x86** |
| 请求 / 响应 body | ≤6MB | ≤6MB |
| 执行时长 | ≤120s（默认 30s） | 1–900s |
| VPC / 内网 | 官方无 VPC 打通说明（**需实测**） | 支持 VPC、固定出口、CFS |
| KV | Cloud Functions **不能访问** Edge KV | 不适用 |

另：**转码禁止上任何函数**（镜像 / 超时 / 可写层三重撞墙，P0）；EdgeOne Edge Functions（JS）无 npm、CPU 200ms，仅可承载极轻逻辑。

## 决策

### 部署矩阵

| 组件 | 首选 | 备选 | 说明 |
|---|---|---|---|
| 分发端 | **EdgeOne Pages Cloud Functions（Go 1.26）** | **同级目标**：SCF 容器（静态 Go 二进制 + distroless，监听 9000） | 同一二进制，两个目标零改动；**两者都必须随时可部署**（产品化要求，见下） |
| 管理端 API + Admin SPA | Docker Compose（CVM / 轻量服务器 / 云托管） | — | 常驻容器；SPA 静态产物由管理端或 COS / EdgeOne Pages 托管 |
| 转码 Worker | Docker Compose 独立容器（与管理端同宿主） | — | 挂大磁盘；任务队列走 DB |
| 数据库 | TDSQL-C MySQL（生产）/ SQLite（开发与小型自托管） | — | ADR-0004 |
| 对象存储 | COS（S3 兼容）+ EdgeOne 加速域名 | MinIO（开发）/ 本地卷（自托管） | ADR-0005 |

### P0 验证结果与决策（2026-09-17 用户拍板）

1. **EdgeOne Cloud Functions ↔ 内网连通性：不通（已确认）。** 决策：彻底不做内网依赖——
   - 数据库连接支持**公网可达**（强制 TLS）：OpenVOD 定位为多部署者产品，部署者可自带数据库（任意可达的 MySQL），不要求腾讯云内网；
   - **SCF Docker 容器作为同级部署目标持续就绪**（部署者在其下可走 VPC 或公网，自行选择），发布流水线两条路径都维护。
2. **Prisma + Bun 兼容性**：若不兼容则**更换 ORM（倾向 Drizzle）**，运行时坚持 Bun（ADR-0004）。
3. **域名备案：已完成**（用户确认），不再是阻塞项。

### 发布流水线（CNB + Taskfile）

```
task deploy =
  db:migrate            # Prisma migrate deploy（生产 MySQL）
  image:build           # docker buildx build --platform linux/amd64（SCF 仅 x86）
  image:push            # 推 TCR（同地域私有仓库）
  delivery:rollout      # EdgeOne Makers 发布（已检查的 .edgeone 产物）或 SCF 函数更新
  admin:rollout         # 管理端 + Worker 滚动更新
  smoke                 # P0 冒烟断言（下）
```

CI 硬门禁（延续前期文档）：
- `assert-unsigned-403`：对加速域名发无签名 m3u8 / 分片请求，断言 403；
- `assert-no-store`：密钥与清单端点响应头必须 `Cache-Control: no-store`，且不得进入任何 CDN / 边缘缓存。

### EdgeOne Go 构建与发布修订（2026-09-22）

Go Framework 模式由平台生成 catch-all，入口文件名决定前缀：`index.go` 对应根路径，
其他文件名会加入前缀（[官方 Go 文档](https://pages.edgeone.ai/document/go)）。
只有 Go 编译成功不能证明 `/healthz` 和 `/v1/...` 已正确发布。

CLI 1.6.41 会递归扫描 `cloud-functions/`。旧的源码副本布局
`cloud-functions/openvod/apps/delivery/internal/server/server.go` 中含 `chi.NewRouter()`，
被识别成 Framework 入口，生成 `^/server(.*)$`，导致根路径 API 不匹配。
因此撤回“隔离构建要求把所有源码放在 cloud-functions 内”的旧判断，采用以下发布约束：

1. `scripts/edgeone.ts prepare` 在 `.run/edgeone-delivery/` 生成独立项目：根目录放原模块的
   `go.mod`、`go.sum`、`app/`、`internal/`；`cloud-functions/` 只有 `index.go`，不使用嵌套模块或 `replace`。
   最小 `package.json` 不安装 workspace 依赖，`public/` 为空静态目录。
2. `task build:edgeone` 调用 `bun --no-env-file scripts/edgeone.ts build`，交叉编译并运行固定的
   `bunx --bun edgeone@1.6.41 makers build`；随后检查生成的 Go 函数配置为 Chi 根 catch-all、二进制为 Linux amd64 ELF。
   项目根模块的支持依据固定 CLI 的实现与实际构建验证；升级 CLI 必须重跑该门禁。
3. `bun --no-env-file scripts/edgeone.ts deploy` 重新检查产物，并复用脚本内固定的 CLI 版本，
   在暂存项目内显式上传 `.edgeone` 到 `openvod-delivery` 的 `production` 环境，Token 由 stage 密钥注入。
   显式目录使用已检查产物，避免部署时隐式重建
   （[官方 CLI 文档](https://pages.edgeone.ai/document/edgeone-cli)）。
4. 部署后对 `EO_DELIVERY_URL`（默认 `https://delivery.ovod.skirk.cn`）执行健康 JSON 与无签名 403 冒烟。
   Makers HTML `NOT_FOUND` 说明尚未命中 delivery，需继续核查域名绑定、生产部署与产物路由。

发布入口统一为 CNB EdgeOne 按钮或同等命令，不使用仓库根的隐式构建 / Git 自动部署。
运行装配仍由 `apps/delivery/app` 单点维护，SCF 与 EdgeOne 入口共用内部装配逻辑。
完整命令与部署验收见 [分发端部署](../deploy-delivery.md)。

### Go Framework 引导变量补充（2026-09-22）

控制台变量在发布前已保存并对生产生效，但上传 `.edgeone` 的 Go 实例仍读不到
`DELIVERY_DATABASE_URL`（部署 `dpiljo0vcwwh` 的运行日志），因此不能继续依赖平台隐式注入。
发布阶段改为使用 `EO_SECRET` 只读查询确切项目的 Production 环境，校验并筛选
`DELIVERY_DATABASE_URL`、`MASTER_KEYS`，保存为私有函数目录内的 `openvod-runtime-env.json`。
EdgeOne 入口在共享装配前加载该文件，只补齐缺失变量；监听强制为 `:9000`。
SCF 入口不加载文件。两种目标仍共用业务装配。

该文件是部署时生成的敏感配置，不是源码或静态资源：本地 `0600`、发布完成 / 失败清理，
禁止入库、日志输出、公开归档及放入 `assets`。私有函数包现在也属于主密钥保管边界，
应与平台环境变量采用同级访问控制；不将 MK 写入数据库，也不把 admin 全权连接传给 delivery。
缺少生产配置时在上传前失败，配置变更需重新部署。

### 就绪检查与状态码适配补充（2026-09-22）

- 发布后的就绪检查允许冷启动：先独立等待 `/healthz` 的 delivery 成功 JSON，单次 30s、
  总窗口 120s、间隔 5s，仅重试网络 / 平台暂态错误；就绪后顺序执行鉴权检查，避免并发触发额外冷启动。
- `RunEdgeOne()` 在共享 `run()` 外包装 Makers 响应协议。固定 CLI 的中间件生成并不保证被根模块下的
  嵌套路由接入；必须在 HTTP 响应提交前设置平台状态头，保留业务 401/403 以及正文、缓存策略。
  SCF 使用原 `Run()`，不增加平台专用响应头。
- 2026-10-17 修订：新版本实例就绪前，平台对新实例的请求会返回 500
  `INTERNAL_CLOUD_FUNCTION_NOT_READY`（正文非 JSON），且 `/healthz` 可能先于其余路由成功。
  因此六项鉴权探测的暂态失败（平台 5xx / HTML 404 / 网络重置与超时）也在同一 120s 窗口内
  逐项重试；重定向、错误服务与错误 JSON 仍立即失败（`scripts/check-delivery-deployment.ts`）。

## 理由

- Go 静态二进制是唯一能同时满足「EdgeOne CF 原生」与「SCF 容器」两个目标的形态。
- 分片字节永远不经过云函数（P0）：CDN 直出 + 签名 URL；函数只承载清单 / 密钥 / 元数据 API。

## 后果与风险

- Cloud Functions 120s 超时对 API 足够；不能承载任何转码（P0，永久约束）。
- 分发端冷启动百毫秒级，可接受；清单与密钥路由保持同一函数实例以减少冷启动。
- 大陆与海外加速需分别配置地域（`edgeone.json` 的 `cloudFunctions.regions.mainland` / `overseas` 各限一个地域）。
