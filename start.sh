#!/usr/bin/env bash
# =============================================================================
# OpenVOD 一键启动：管理端（Control Plane）+ 分发端（Data Plane）
#
# 用法：
#   ./start.sh                    启动全部（后台运行，日志写入 .run/）
#   ./start.sh stop               停止全部
#   ./start.sh status             查看运行状态
#   ./start.sh logs <admin|web|delivery>   跟踪某个服务日志
#
# 组件与端口：
#   admin     管理端 API（apps/admin，Bun + Hono）    :8787   GET /healthz
#   web       管理端前端（apps/admin-web，Vite）      :5173
#   delivery  分发端（apps/delivery，Go + Chi）       :9000   GET /healthz
# =============================================================================
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"
RUN_DIR="$ROOT/.run"
mkdir -p "$RUN_DIR"

SVC_ADMIN_URL="http://localhost:8787/healthz"
SVC_WEB_URL="http://localhost:5173"
SVC_DELIVERY_URL="http://localhost:9000/healthz"

# ---- 公共：加载 .env / 依赖准备 ---------------------------------------------
load_env() {
  if [ ! -f "$ROOT/.env" ]; then
    cp "$ROOT/.env.example" "$ROOT/.env"
    echo "[env] .env 不存在，已从 .env.example 生成（开发库建议改用 SQLite，见该文件注释）"
  fi
  set -a; . "$ROOT/.env"; set +a
}

ensure_deps() {
  command -v bun >/dev/null 2>&1 || { echo "错误：未找到 bun"; exit 1; }
  if [ ! -d "$ROOT/node_modules" ]; then
    echo "[deps] 安装 workspace 依赖（bun i）..."
    (cd "$ROOT" && bun i)
  fi
  if [ ! -d "$ROOT/packages/db/generated" ]; then
    echo "[deps] 生成 Prisma 客户端（DB_PROVIDER=${DB_PROVIDER:-sqlite}）..."
    (cd "$ROOT" && bun run --cwd packages/db "generate:${DB_PROVIDER:-sqlite}")
  fi
}

probe() { curl -fsS -m 2 -o /dev/null "$1" 2>/dev/null; }

wait_http() { # $1=url $2=名称
  local i
  for i in $(seq 1 40); do
    if probe "$1"; then echo "[$2] 就绪：$1"; return 0; fi
    sleep 0.5
  done
  echo "[$2] 启动超时：$1（查看 .run/*.log 定位原因）"
  return 1
}

start_one() { # $1=名称 $2=pidfile $3=logfile $4=探测URL $5...=启动命令
  local name="$1" pidfile="$2" logfile="$3" url="$4"
  shift 4
  if probe "$url"; then
    echo "[$name] 已在运行，跳过（$url）"
    return 0
  fi
  echo "[$name] 启动：$*"
  ( "$@" >"$logfile" 2>&1 & echo $! >"$pidfile" )
  wait_http "$url" "$name"
}

# ---- 子命令 -----------------------------------------------------------------
cmd_start() {
  load_env
  ensure_deps
  command -v go >/dev/null 2>&1 || { echo "错误：未找到 go（分发端需要）"; exit 1; }

  start_one admin "$RUN_DIR/admin.pid" "$RUN_DIR/admin.log" "$SVC_ADMIN_URL" \
    bun run --cwd apps/admin dev

  start_one web "$RUN_DIR/web.pid" "$RUN_DIR/web.log" "$SVC_WEB_URL" \
    bun run --cwd apps/admin-web dev

  if probe "$SVC_DELIVERY_URL"; then
    echo "[delivery] 已在运行，跳过（$SVC_DELIVERY_URL）"
  else
    echo "[delivery] 编译（go build）..."
    (cd apps/delivery && go build -o "$RUN_DIR/delivery" .)
    echo "[delivery] 启动 $RUN_DIR/delivery"
    ( "$RUN_DIR/delivery" >"$RUN_DIR/delivery.log" 2>&1 & echo $! >"$RUN_DIR/delivery.pid" )
    wait_http "$SVC_DELIVERY_URL" delivery
  fi

  echo
  echo "全部就绪："
  echo "  管理端 API   http://localhost:8787"
  echo "  管理端前端   http://localhost:5173"
  echo "  分发端       http://localhost:9000"
  echo "停止：./start.sh stop    状态：./start.sh status    日志：./start.sh logs <admin|web|delivery>"
}

stop_pidfile() { # $1=名称 $2=pidfile
  if [ -f "$2" ]; then
    local pid
    pid="$(cat "$2")"
    if kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || true
      sleep 0.3
      if kill -0 "$pid" 2>/dev/null; then kill -9 "$pid" 2>/dev/null || true; fi
      echo "[$1] 已停止（pid $pid）"
    else
      echo "[$1] 未在运行（清理残留 pid $pid）"
    fi
    rm -f "$2"
  else
    echo "[$1] 无 pid 文件，跳过"
  fi
}

cmd_stop() {
  stop_pidfile delivery "$RUN_DIR/delivery.pid"
  stop_pidfile web      "$RUN_DIR/web.pid"
  stop_pidfile admin    "$RUN_DIR/admin.pid"
}

status_one() { # $1=名称 $2=url $3=pidfile
  local state="stopped"
  probe "$2" && state="running"
  local pid="-"
  [ -f "$3" ] && pid="$(cat "$3")"
  printf "  %-9s %-9s (pid %s)  %s\n" "$1" "$state" "$pid" "$2"
}

cmd_status() {
  echo "OpenVOD 运行状态："
  status_one admin    "$SVC_ADMIN_URL"    "$RUN_DIR/admin.pid"
  status_one web      "$SVC_WEB_URL"      "$RUN_DIR/web.pid"
  status_one delivery "$SVC_DELIVERY_URL" "$RUN_DIR/delivery.pid"
}

cmd_logs() {
  local name="${1:-}"
  local file=""
  case "$name" in
    admin)    file="$RUN_DIR/admin.log" ;;
    web)      file="$RUN_DIR/web.log" ;;
    delivery) file="$RUN_DIR/delivery.log" ;;
    *) echo "用法：./start.sh logs <admin|web|delivery>"; exit 1 ;;
  esac
  [ -f "$file" ] || { echo "[$name] 暂无日志（$file）"; exit 0; }
  tail -n 50 -f "$file"
}

case "${1:-start}" in
  start)  cmd_start ;;
  stop)   cmd_stop ;;
  status) cmd_status ;;
  logs)   cmd_logs "${2:-}" ;;
  *) sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'; exit 1 ;;
esac
