# OpenVOD

自建云点播系统：媒资库、转码、加密分发（HLS AES-128 + URL 签名）、元数据、WebVTT 字幕。

- 决策文档：[docs/vod/README.md](./docs/vod/README.md)（intent + ADR-0001 ~ 0011 + open-questions）
- 分发端 Data Plane：`apps/delivery`（Go 1.26 + Chi，EdgeOne Cloud Functions / SCF 容器）
- 管理端 Control Plane：`apps/admin`（Bun + Hono + Prisma）、`apps/admin-web`（React + Vite + Ant Design）、`apps/worker`（ffmpeg 常驻容器）

## 快速开始

```bash
bun i                     # 安装依赖（workspaces）
cp .env.example .env      # 配置环境变量
task db:generate          # 生成 Prisma 客户端（按 DB_PROVIDER 方言）
task db:push              # 开发库建表（SQLite）
task contracts            # zod → JSON Schema → Go struct（生成物入库，ADR-0001 门禁）
task vectors              # 生成 TS/Go 加密互通测试向量
task dev:admin            # 管理端 API :8787
task dev:web              # 管理端前端 :5173
task dev:delivery         # 分发端 :9000
task test                 # bun test + go test
```

工具链要求见 `.ide/Dockerfile`（Bun 1.4 / Go 1.26 / ffmpeg / quicktype / Task）。
