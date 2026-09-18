#!/usr/bin/env bash
# =============================================================================
# 启动管理端 Control Plane（ADR-0013：Next.js 全栈单应用，UI + API 同容器）
#   http://localhost:${ADMIN_PORT:-8787}
# 同时**一并启动转码 Worker**（后台，日志 .run/worker.log）：worker 是 transcode_jobs
#   队列的唯一消费者，只起管理端会让「更多 → 转码」发起的任务永远停在「排队中」。
#   本脚本退出（含 Ctrl-C）时会把它一并停掉；要独立常驻请用 ./start-worker.sh。
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
# 注意：packages/db/src/index.ts 静态导入两份客户端（Next/webpack 打包时需同时可解析），
# 因此 mysql 与 sqlite 生成物必须都存在，与 DB_PROVIDER 取值无关。
if [ ! -d "$ROOT/packages/db/generated/mysql" ] || [ ! -d "$ROOT/packages/db/generated/sqlite" ]; then
  echo "[deps] 生成 Prisma 客户端（mysql + sqlite）..."
  (cd "$ROOT" && bun run --cwd packages/db generate:mysql && bun run --cwd packages/db generate:sqlite)
fi

# ---- 转码 Worker（与 admin 一起起落）----------------------------------------
RUN_DIR="$ROOT/.run"
mkdir -p "$RUN_DIR"
. "$ROOT/scripts/worker.sh"

STARTED_WORKER=0
cleanup() {
  if [ "$STARTED_WORKER" = 1 ]; then
    STARTED_WORKER=0 # 幂等：INT 与 EXIT 两个 trap 可能各触发一次
    echo
    echo "[admin] 退出：一并停止本次启动的 worker（要独立常驻请用 ./start-worker.sh）"
    stop_worker
  fi
}
trap cleanup EXIT INT TERM

# 已经有一个在跑（例如 ./start.sh 起的）→ 不重复启动，退出时也不动它
if worker_alive; then
  echo "[worker] 已在运行，沿用现有实例（退出时不停止它）"
else
  start_worker && STARTED_WORKER=1
fi

if [ "$STARTED_WORKER" = 1 ]; then
  echo "[admin] 启动 Next.js 管理端：http://localhost:${ADMIN_PORT:-8787}（Ctrl-C 退出，本次启动的 worker 一并收掉）"
else
  echo "[admin] 启动 Next.js 管理端：http://localhost:${ADMIN_PORT:-8787}（Ctrl-C 退出；worker 沿用已有实例，不动它）"
fi
# 这里不能用 exec：exec 会替换掉本 shell，trap 失效 → worker 变孤儿进程
bun run --cwd apps/admin dev
