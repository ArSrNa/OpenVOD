#!/usr/bin/env bash
# =============================================================================
# 启动管理端 Control Plane（ADR-0013：Next.js 全栈单应用，UI + API 同容器）
#   http://localhost:${ADMIN_PORT:-8787}
# 前置：task db:generate（Prisma 客户端）、task db:push（SQLite 开发库建表）
# =============================================================================
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

# ---- 加载 .env（root .env 同时供脚本 / Worker 使用；Next 只读 apps/admin/.env）----
if [ ! -f "$ROOT/.env" ]; then
  cp "$ROOT/.env.example" "$ROOT/.env"
  echo "[env] .env 不存在，已从 .env.example 生成（开发建议 DB_PROVIDER=sqlite + DATABASE_URL=file:./dev.db）"
fi
set -a; . "$ROOT/.env"; set +a

command -v bun >/dev/null 2>&1 || { echo "错误：未找到 bun"; exit 1; }

# ---- 依赖 / Prisma 生成物 ----
if [ ! -d "$ROOT/node_modules" ]; then
  echo "[deps] 安装 workspace 依赖（bun i）..."
  (cd "$ROOT" && bun i)
fi
if [ ! -d "$ROOT/packages/db/generated" ]; then
  echo "[deps] 生成 Prisma 客户端（DB_PROVIDER=${DB_PROVIDER:-sqlite}）..."
  (cd "$ROOT" && bun run --cwd packages/db "generate:${DB_PROVIDER:-sqlite}")
fi

echo "[admin] 启动 Next.js 管理端：http://localhost:${ADMIN_PORT:-8787}（Ctrl-C 退出）"
exec bun run --cwd apps/admin dev
