#!/usr/bin/env bash
# =============================================================================
# 启动分发端 Data Plane（apps/delivery，Go + Chi，默认 :9000，前台运行）
# 每次启动自动增量编译（产物 .run/delivery），配置从根目录 .env 读取：
#   DELIVERY_LISTEN（默认 ":9000"）、MASTER_KEYS、URL_SIGN_KEY_HEX
# =============================================================================
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"
RUN_DIR="$ROOT/.run"
mkdir -p "$RUN_DIR"

URL="http://localhost:9000/healthz"

# ---- 公共：加载 .env ---------------------------------------------------------
if [ ! -f "$ROOT/.env" ]; then
  cp "$ROOT/.env.example" "$ROOT/.env"
  echo "[env] .env 不存在，已从 .env.example 生成"
fi
set -a; . "$ROOT/.env"; set +a

command -v go >/dev/null 2>&1 || { echo "错误：未找到 go"; exit 1; }

probe() { curl -fsS -m 2 -o /dev/null "$1" 2>/dev/null; }

if probe "$URL"; then
  echo "[delivery] 已在运行，无需重复启动（$URL）"
  echo "如需重启：./start.sh stop && ./start-delivery.sh"
  exit 0
fi

echo "[delivery] 编译（go build）..."
(cd apps/delivery && go build -o "$RUN_DIR/delivery" .)

PORT="${DELIVERY_LISTEN:-:9000}"
PORT="${PORT#:}"
echo "[delivery] 启动（前台）：http://localhost:$PORT（Ctrl-C 退出）"
exec "$RUN_DIR/delivery"
