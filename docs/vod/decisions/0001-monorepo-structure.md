# ADR-0001：Monorepo 结构与工程化

- 状态：已接受（沿用 `.ide/Dockerfile` 与前期文档既定方向）
- 日期：2026-09-17
- 关联：ADR-0002、ADR-0003

## 背景

双端 + 双语言（分发端 Go、管理端 TS）+ 共享数据库，必须在一个仓库内解决：包边界、契约同步、工具链统一、CI 编排（CNB）。

## 决策

### 目录结构

```
/
├── apps/
│   ├── delivery/            # 分发端（Go 1.26 + Chi）— 面向播放端 App 的 API
│   ├── admin/               # 管理端 API（Bun + Hono + Prisma）
│   ├── admin-web/           # 管理端前端（React + Vite SPA）
│   └── worker/              # 转码 Worker（TS 入口，常驻容器：ffmpeg / Bento4）
├── packages/
│   ├── contracts/           # 唯一契约源：zod schema → JSON Schema → Go struct
│   ├── db/                  # Prisma schema、迁移、生成客户端、种子
│   ├── storage/             # 本地 / S3(COS/MinIO) 存储适配层
│   ├── transcode/           # ffmpeg / Bento4 封装、ladder、任务执行逻辑
│   ├── crypto/              # MK 封装/解封、CEK 生成、URL 签名（TS 侧实现）
│   └── shared/              # 错误码、常量、工具类型
├── docs/vod/                # 本决策文档
├── .cnb.yml                 # CNB CI/CD（已存在）
├── Taskfile.yml             # 本地与部署编排入口
└── .ide/Dockerfile          # CNB 云开发环境镜像（已存在）
```

### 契约流（双语言防漂移）

```
packages/contracts（zod，唯一真相源）
  → bun run contracts:json   # zod → JSON Schema
  → bun run contracts:go     # JSON Schema → Go struct（quicktype）
       输出 apps/delivery/internal/contracts/（生成物提交入库）
  → CI 门禁：git diff --exit-code apps/delivery/internal/contracts/
```

- API DTO 与错误码以 contracts 为准，Go 侧不手写对应结构体。
- 数据库表的 Go 读模型不强制生成（分发端只读写少数表），以集成测试对齐（ADR-0004）。

### 工具链

- JS/TS：Bun（workspaces + 运行时 + `bun test`）
- Go：标准 go 工具链 + golangci-lint
- 编排：Taskfile（`task dev` / `task build` / `task deploy`）；CI 用 CNB（`.cnb.yml` 与 web_trigger 镜像构建已配置）
- 提交规范：conventional commits；v1 不引入 changesets（提议）

## 理由

- worker 以 TS 入口复用 packages/{db,storage,transcode,crypto} 全部领域逻辑，避免第三种语言重复实现队列与 IO。
- 契约生成物入库 + CI diff 门禁是唯一可执行的防漂移手段（"生成了但没人跑"等于没做）。
- 开发环境镜像已按此结构备齐工具（Go 1.26、quicktype、ffmpeg、Bento4、MinIO mc、Task、edgeone CLI），零额外成本。

## 备选（否决 / 搁置）

- 全 TS 单语言 monorepo：开发效率最高，但放弃分发端 Go 的运行时优势（EdgeOne CF Go 原生、静态二进制、冷启动小）—— 用户已选定 Go。
- Turborepo / Nx 任务缓存：当前包数量少、构建快，先不引入，结构上保留接入余地。

## 后果与风险

- URL 签名、JWT 验签等公共逻辑在 Go 与 TS 各有一份实现，必须以共享测试向量（fixtures）保证互通 —— 列入 specification 必做项。
- CI 需同时跑两个工具链的测试矩阵。
