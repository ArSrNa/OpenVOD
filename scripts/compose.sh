#!/usr/bin/env sh
# =============================================================================
# compose.sh — OpenVOD 单机容器形态（admin + worker + player）启停封装
#
# 与 scripts/dev.ts 的分工：
#   dev.ts      源码直跑（开发调试：next dev / bun --watch / go run）
#   compose.sh  预构建镜像 + docker compose（常驻运行：CNB 云原生开发环境 / CVM / 轻量）
#
# 用法：
#   scripts/compose.sh up            拉取镜像并启动（缺 .env 时提示先生成）
#   scripts/compose.sh down          停止并移除容器（镜像与卷保留）
#   scripts/compose.sh ps            状态
#   scripts/compose.sh logs [服务]   跟日志（默认全部；如 admin / worker / player）
#   scripts/compose.sh restart [服务]
#   scripts/compose.sh url           打印 CNB 预览地址（由 CNB_VSCODE_PROXY_URI 推导）
#
# 说明：编排定义见根 docker-compose.yml；镜像由流水线预先构建（见 docs/vod/deploy-apps.md）。
# =============================================================================
set -eu

ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT"

# 与 Taskfile 的各 dev 任务同源：显式加载 .env 后再调 compose。
# 必要性：compose 的变量插值（端口映射 / 镜像名）以 shell 环境变量优先于 .env 文件，
# 不先加载会出现「宿主 shell 残留旧值 → 映射端口与容器内端口不一致」。
if [ -f "$ROOT/.env" ]; then
  set -a
  . "$ROOT/.env"
  set +a
fi
ADMIN_PORT=${ADMIN_PORT:-8787}
PLAYER_PORT=${PLAYER_PORT:-3100}
WORKER_TMP=${WORKER_TMP:-$ROOT/.run/worker-tmp}

preview_url() {
  [ -n "${CNB_VSCODE_PROXY_URI:-}" ] || return 0
  printf '%s\n' "$CNB_VSCODE_PROXY_URI" | sed "s/{{port}}/$ADMIN_PORT/g"
}

cmd=${1:-up}
[ $# -gt 0 ] && shift || true

case "$cmd" in
  up)
    if [ ! -f "$ROOT/.env" ]; then
      echo "[compose] 缺少 $ROOT/.env：先在密钥仓库环境执行 sh scripts/gen-env.sh" >&2
      exit 1
    fi
    mkdir -p "$WORKER_TMP"
    # 制品库尚未构建对应镜像时（如首次部署）不阻断：本地已有同名镜像可直接起
    docker compose pull || echo "[compose] 警告：有镜像拉取失败（尚未构建？先在 CNB 点「构建admin/worker/player（Docker）」按钮）——尝试用本地同名镜像继续" >&2
    docker compose up -d
    docker compose ps
    u=$(preview_url) || true
    if [ -n "${u:-}" ]; then
      echo "[compose] 管理端预览：$u（若打不开，在 WebIDE 的 PORTS 面板添加 $ADMIN_PORT）"
    fi
    p=$(printf '%s\n' "${CNB_VSCODE_PROXY_URI:-}" | sed "s/{{port}}/$PLAYER_PORT/g")
    if [ -n "${p:-}" ]; then
      echo "[compose] 播放演示预览：$p（免登录；预览账号用 apps/admin/scripts/bootstrap-playback.ts 创建）"
    fi
    echo "[compose] worker 无端口：转码进度看管理端「转码任务」页；日志 scripts/compose.sh logs worker"
    ;;
  down)    docker compose down ;;
  ps)      docker compose ps ;;
  logs)    docker compose logs -f --tail=100 "$@" ;;
  restart) docker compose restart "$@" ;;
  url)     preview_url ;;
  *)
    echo "用法：$0 {up|down|ps|logs [服务]|restart [服务]|url}" >&2
    exit 2
    ;;
esac
