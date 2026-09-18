#!/usr/bin/env bash
# =============================================================================
# scripts/worker.sh — 转码 Worker 的生命周期函数（被 ./start.sh / ./start-admin.sh source）
#
# 为什么单列一个文件：worker 是 transcode_jobs 队列的**唯一消费者**，不启动它，管理端发起的
# 转码任务会一直停在「排队中」（attempts=0 / lease_until 为空 = 从未被认领）。因此把它并进
# 常用启动脚本，并把这段逻辑收敛到一处，避免 start.sh 与 start-admin.sh 各写一份而漂移。
#
# 约定：调用方需先定义 ROOT 与 RUN_DIR，并已加载根 .env
#      （worker 需要 DATABASE_URL / DB_PROVIDER / MASTER_KEYS / STORAGE_*）。
#      worker 没有 HTTP 端口，存活判定用 .run/worker.pid。
# =============================================================================

worker_alive() {
  [ -f "$RUN_DIR/worker.pid" ] || return 1
  kill -0 "$(cat "$RUN_DIR/worker.pid")" 2>/dev/null
}

# 后台启动（幂等：已在运行则跳过并返回 0）；成功返回 0，失败返回 1
start_worker() {
  local pidfile="$RUN_DIR/worker.pid" logfile="$RUN_DIR/worker.log"
  if worker_alive; then
    echo "[worker] 已在运行，跳过（pid $(cat "$pidfile")）"
    return 0
  fi
  if ! command -v ffmpeg >/dev/null 2>&1 || ! command -v ffprobe >/dev/null 2>&1; then
    echo "[worker] 警告：未找到 ffmpeg/ffprobe，转码任务会失败（镜像应含，见 .ide/Dockerfile）"
  fi
  echo "[worker] 启动（转码队列消费，日志 $logfile）"
  # setsid：让 bun run 与其 bun --watch 子进程同属一个新进程组，停止时可整组收掉
  local launcher=""
  command -v setsid >/dev/null 2>&1 && launcher="setsid"
  ( $launcher bun run --cwd apps/worker dev >"$logfile" 2>&1 & echo $! >"$pidfile" )
  sleep 1
  if worker_alive; then
    echo "[worker] 就绪（pid $(cat "$pidfile")）"
    return 0
  fi
  echo "[worker] 启动失败，见 $logfile"
  return 1
}

# 停止（幂等；按进程组收掉 bun run + bun --watch，不留孤儿）
stop_worker() {
  local pidfile="$RUN_DIR/worker.pid"
  if [ ! -f "$pidfile" ]; then
    echo "[worker] 无 pid 文件，跳过"
    return 0
  fi
  local pid
  pid="$(cat "$pidfile")"
  if kill -0 "$pid" 2>/dev/null; then
    kill -- "-$pid" 2>/dev/null || true
    pkill -P "$pid" 2>/dev/null || true
    kill "$pid" 2>/dev/null || true
    sleep 0.3
    # bun --watch 会吞掉 SIGTERM，必须用 SIGKILL 兜底（否则留下看不见的孤儿消费者）
    kill -9 -- "-$pid" 2>/dev/null || true
    pkill -9 -P "$pid" 2>/dev/null || true
    if kill -0 "$pid" 2>/dev/null; then
      echo "[worker] 警告：pid $pid 在 SIGKILL 后仍存活，请手动处理：kill -9 -- -$pid"
      rm -f "$pidfile"
      return 1
    fi
    echo "[worker] 已停止（pid $pid）"
  else
    echo "[worker] 未在运行（清理残留 pid $pid）"
  fi
  rm -f "$pidfile"
}

status_worker() {
  local state="stopped" pid="-"
  if [ -f "$RUN_DIR/worker.pid" ]; then
    pid="$(cat "$RUN_DIR/worker.pid")"
    if kill -0 "$pid" 2>/dev/null; then state="running"; fi
  fi
  printf "  %-9s %-9s (pid %s)  %s\n" "worker" "$state" "$pid" "转码队列消费（无 HTTP 端口）"
}
