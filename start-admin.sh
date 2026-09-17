#!/usr/bin/env bash
# =============================================================================
# 启动管理端 Control Plane：
#   admin API（apps/admin，Bun + Hono）   :8787   后台运行，日志 .run/admin.log
#   管理前端（apps/admin-web，Vite）      :5173   前台运行
# Ctrl-C 退出前端时，自动停止后台 admin API。
# =============================================================================
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"
RUN_DIR="$ROOT/.run"
mkdir -p "$RUN_DIR"

API_URL="http://localhost:8787/healthz"
WEB_URL="http://localhost:5173"

# ---- 公共：加载 .env / 依赖准备 ---------------------------------------------
if [ ! -f "$ROOT/.env" ]; then
  cp "$ROOT/.env.example" "$ROOT/.env"
  echo "[env] .env 不存在，已从 .env.example 生成（开发库建议改用 SQLite，见该文件注释）"
fi
set -a; . "$ROOT/.env"; set +a

command -v bun >/dev/null 2>&1 || { echo "错误：未找到 bun"; exit 1; }
if [ ! -d "$ROOT/node_modules" ]; then
  echo "[deps] 安装 workspace 依赖（bun i）..."
  (cd "$ROOT" && bun i)
fi
if [ ! -d "$ROOT/packages/db/generated" ]; then
  echo "[deps] 生成 Prisma 客户端（DB_PROVIDER=${DB_PROVIDER:-sqlite}）..."
  (cd "$ROOT" && bun run --cwd packages/db "generate:${DB_PROVIDER:-sqlite}")
fi

probe() { curl -fsS -m 2 -o /dev/null "$1" 2>/dev/null; }

wait_http() { # $1=url $2=名称
  local i
  for i in $(seq 1 40); do
    if probe "$1"; then echo "[$2] 就绪：$1"; return 0; fi
    sleep 0.5
  done
  echo "[$2] 启动超时：$1（查看 .run/admin.log 定位原因）"
  return 1
}

API_PID=""
cleanup() {
  if [ -n "$API_PID" ] && kill -0 "$API_PID" 2>/dev/null; then
    echo
    echo "[admin API] 停止（pid $API_PID）"
    kill "$API_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

# ---- admin API（后台） -------------------------------------------------------
if probe "$API_URL"; then
  echo "[admin API] 已在运行，跳过（$API_URL）"
else
  echo "[admin API] 启动（后台，日志 .run/admin.log）"
  ( bun run --cwd apps/admin dev >"$RUN_DIR/admin.log" 2>&1 & echo $! >"$RUN_DIR/admin.pid" )
  API_PID="$(cat "$RUN_DIR/admin.pid")"
  wait_http "$API_URL" "admin API"
fi

# ---- 管理前端（前台） ---------------------------------------------------------
echo "[admin web] 启动（前台）：$WEB_URL（Ctrl-C 退出，会自动停掉 admin API）"
bun run --cwd apps/admin-web dev
