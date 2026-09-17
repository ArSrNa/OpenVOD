# ADR-0003：部署目标与发布流水线

- 状态：已接受（平台事实经官方文档核实，2026-09；含 P0 验证项）
- 日期：2026-09-17
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
  delivery:rollout      # EdgeOne Pages 发布（edgeone pages deploy）或 SCF 函数更新
  admin:rollout         # 管理端 + Worker 滚动更新
  smoke                 # P0 冒烟断言（下）
```

CI 硬门禁（延续前期文档）：
- `assert-unsigned-403`：对加速域名发无签名 m3u8 / 分片请求，断言 403；
- `assert-no-store`：密钥与清单端点响应头必须 `Cache-Control: no-store`，且不得进入任何 CDN / 边缘缓存。

## 理由

- Go 静态二进制是唯一能同时满足「EdgeOne CF 原生」与「SCF 容器」两个目标的形态。
- 分片字节永远不经过云函数（P0）：CDN 直出 + 签名 URL；函数只承载清单 / 密钥 / 元数据 API。

## 后果与风险

- Cloud Functions 120s 超时对 API 足够；不能承载任何转码（P0，永久约束）。
- 分发端冷启动百毫秒级，可接受；清单与密钥路由保持同一函数实例以减少冷启动。
- 大陆与海外加速需分别配置地域（`edgeone.json` 的 `mainlandRegions` / `overseasRegions` 各限一个地域）。
