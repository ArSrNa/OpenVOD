#!/usr/bin/env bash
# =============================================================================
# 启动转码 Worker（apps/worker，Bun 常驻，前台运行，无 HTTP 端口）
#   消费 transcode_jobs 队列：管理端「媒资管理 → 更多 → 转码」发起的任务由它认领执行（ADR-0008）
#   需要 ffmpeg / ffprobe；加密模板还需要 MASTER_KEYS
#
# 提示：只起管理端而忘了 Worker，任务会一直停在「排队中」（attempts=0）。
#       `./start-admin.sh` 与 `./start.sh` 已自动带上 Worker；本脚本用于单独前台观察日志。
# =============================================================================
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

# ---- 加载 .env（worker 需要 DATABASE_URL / DB_PROVIDER / MASTER_KEYS / STORAGE_*）----
if [ ! -f "$ROOT/.env" ]; then
  cp "$ROOT/.env.example" "$ROOT/.env"
  echo "[env] .env 不存在，已从 .env.example 生成（开发建议 DB_PROVIDER=sqlite + DATABASE_URL=file:./dev.db）"
fi
set -a; . "$ROOT/.env"; set +a

command -v bun >/dev/null 2>&1 || { echo "错误：未找到 bun"; exit 1; }
if ! command -v ffmpeg >/dev/null 2>&1 || ! command -v ffprobe >/dev/null 2>&1; then
  echo "[worker] 警告：未找到 ffmpeg/ffprobe，转码任务会失败（镜像应含，见 .ide/Dockerfile）"
fi

if [ ! -d "$ROOT/node_modules" ]; then
  echo "[deps] 安装 workspace 依赖（bun i）..."
  (cd "$ROOT" && bun i)
fi

echo "[worker] 启动（前台，Ctrl-C 退出）：轮询间隔 ${WORKER_POLL_INTERVAL_MS:-2000}ms，lease ${WORKER_LEASE_MS:-60000}ms"
exec bun run --cwd apps/worker dev
