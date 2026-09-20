#!/usr/bin/env bash
# =============================================================================
# OpenVOD 一键启动：管理端（Control Plane）+ 分发端（Data Plane）+ 转码 Worker
#
# 用法：
#   ./start.sh                    启动全部（后台运行，日志写入 .run/）
#   ./start.sh stop               停止全部
#   ./start.sh status             查看运行状态
#   ./start.sh logs <admin|delivery|worker>   跟踪某个服务日志
#
# 组件与端口：
#   admin     管理端 UI + API（apps/admin，Next.js 全栈，ADR-0013）  :8787   GET /healthz
#   delivery  分发端（apps/delivery，Go + Chi）                      :9000   GET /healthz
#   worker    转码 Worker（apps/worker，Bun 常驻，ADR-0008）         无端口  转码队列消费者
#
# 注意：**worker 必须一起跑**——否则管理端发起的转码任务会一直停在「排队中」
# （没有消费者认领 transcode_jobs；这是历史上最容易踩的坑）。
# =============================================================================
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"
RUN_DIR="$ROOT/.run"
mkdir -p "$RUN_DIR"

SVC_ADMIN_URL="http://localhost:8787/healthz"
SVC_DELIVERY_URL="http://localhost:9000/healthz"

# ---- 公共：加载 .env / 依赖准备 ---------------------------------------------
load_env() {
  if [ ! -f "$ROOT/.env" ]; then
    # 优先用 scripts/gen-env.sh（环境变量 / 密钥仓库注入 → .env），失败再回落模板
    sh "$ROOT/scripts/gen-env.sh" || cp "$ROOT/.env.example" "$ROOT/.env"
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

# ---- Worker 生命周期（共享实现：scripts/worker.sh；start-admin.sh 用的是同一份）----
. "$ROOT/scripts/worker.sh"

# ---- 子命令 -----------------------------------------------------------------
cmd_start() {
  load_env
  ensure_deps
  command -v go >/dev/null 2>&1 || { echo "错误：未找到 go（分发端需要）"; exit 1; }

  start_one admin "$RUN_DIR/admin.pid" "$RUN_DIR/admin.log" "$SVC_ADMIN_URL" \
    bun run --cwd apps/admin dev

  if probe "$SVC_DELIVERY_URL"; then
    echo "[delivery] 已在运行，跳过（$SVC_DELIVERY_URL）"
  else
    echo "[delivery] 编译（go build）..."
    (cd apps/delivery && go build -o "$RUN_DIR/delivery" .)
    echo "[delivery] 启动 $RUN_DIR/delivery"
    ( "$RUN_DIR/delivery" >"$RUN_DIR/delivery.log" 2>&1 & echo $! >"$RUN_DIR/delivery.pid" )
    wait_http "$SVC_DELIVERY_URL" delivery
  fi

  # 队列消费者：不启动它，管理端发起的转码任务会一直停在「排队中」
  start_worker || echo "[worker] 启动失败：转码任务将停在「排队中」，见 $RUN_DIR/worker.log"

  echo
  echo "全部就绪："
  echo "  管理端（UI + API）   http://localhost:8787"
  echo "  分发端               http://localhost:9000"
  echo "  转码 Worker          后台常驻（无端口；./start.sh logs worker 看认领与转码日志）"
  echo "停止：./start.sh stop    状态：./start.sh status    日志：./start.sh logs <admin|delivery|worker>"
}

stop_pidfile() { # $1=名称 $2=pidfile
  if [ -f "$2" ]; then
    local pid
    pid="$(cat "$2")"
    if kill -0 "$pid" 2>/dev/null; then
      # 先收子进程再杀父进程：bun run 会派生 next dev，反序会留下孤儿继续占用端口
      pkill -P "$pid" 2>/dev/null || true
      kill "$pid" 2>/dev/null || true
      sleep 0.3
      if kill -0 "$pid" 2>/dev/null; then kill -9 "$pid" 2>/dev/null || true; fi
      pkill -9 -P "$pid" 2>/dev/null || true
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
  stop_worker
  stop_pidfile delivery "$RUN_DIR/delivery.pid"
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
  status_one delivery "$SVC_DELIVERY_URL" "$RUN_DIR/delivery.pid"
  status_worker
}

cmd_logs() {
  local name="${1:-}"
  local file=""
  case "$name" in
    admin)    file="$RUN_DIR/admin.log" ;;
    delivery) file="$RUN_DIR/delivery.log" ;;
    worker)   file="$RUN_DIR/worker.log" ;;
    *) echo "用法：./start.sh logs <admin|delivery|worker>"; exit 1 ;;
  esac
  [ -f "$file" ] || { echo "[$name] 暂无日志（$file）"; exit 0; }
  tail -n 50 -f "$file"
}

case "${1:-start}" in
  start)  cmd_start ;;
  stop)   cmd_stop ;;
  status) cmd_status ;;
  logs)   cmd_logs "${2:-}" ;;
  *) sed -n '2,14p' "$0" | sed 's/^# \{0,1\}//'; exit 1 ;;
esac
