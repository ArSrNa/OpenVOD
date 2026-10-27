#!/usr/bin/env sh
# =============================================================================
# compose-infra.sh — CNB 本地基础设施底座（MySQL + RustFS）启停封装
#
# 与 scripts/compose.sh 的分工：
#   compose.sh        根 docker-compose.yml（预构建 admin + worker 应用镜像）
#   compose-infra.sh  docker-compose.infra.yml（官方公共镜像 mysql + rustfs，开发底座）
#
# 首次 up 自动完成：
#   1) 生成 .run/infra.env（随机口令 / AK-SK，chmod 600；.run/ 已 gitignore，不覆盖既有值）
#   2) docker compose up -d（项目名 openvod-infra，与根编排 openvod 互不影响）
#   3) 等 mysql 健康 → 幂等建分发端受限账号 openvod_ro
#      （ADR-0011：users / media / media_subtitles / hls_keys / signing_keys /
#        system_settings / transcode_templates 只读 + playback_sessions 读写，
#        其余拒绝；口令与 .run/infra.env 保持同步）
#
# 端口等变量可被 shell 环境同名覆盖（INFRA_MYSQL_PORT / INFRA_RUSTFS_API_PORT /
# INFRA_RUSTFS_CONSOLE_PORT / INFRA_BIND / INFRA_MYSQL_IMAGE / INFRA_RUSTFS_IMAGE），
# compose 插值也是 shell 优先于 .run/infra.env——覆盖时两边行为一致。
#
# 用法：
#   scripts/compose-infra.sh up                启动（幂等，可重复执行）
#   scripts/compose-infra.sh down              停止（数据卷保留）
#   scripts/compose-infra.sh reset             停止并删除数据卷（清空本地数据，慎用）
#   scripts/compose-infra.sh ps                状态
#   scripts/compose-infra.sh logs [服务]       跟日志（mysql / rustfs）
#   scripts/compose-infra.sh restart [服务]    重启
#   scripts/compose-infra.sh init-env          生成/更新 .env.trial（不动根 .env，见下）
#   scripts/compose-infra.sh env               打印连接串（含口令，勿外传）
#   scripts/compose-infra.sh url               打印 RustFS 控制台 CNB 预览地址
#
# .env.trial 机制（全程不改根 .env）：
#   init-env 以根 .env（若有）为底、仅覆盖 DB_PROVIDER / DATABASE_URL
#   三个键（其余键原样继承；无根 .env 则生成必需最小集，MASTER_KEYS 随机生成），
#   输出 .env.trial（600，已被 .gitignore 的 .env.* 规则忽略，重复执行整体重新生成）。
#   三端启动用：bun scripts/dev.ts --env-file .env.trial ...（dev.ts 指定后不再读根 .env）；
#   Prisma（task db:migrate）不认识 .env.trial，需先导出：set -a && . ./.env.trial && set +a
# =============================================================================
set -eu

ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT"

COMPOSE_FILE="$ROOT/docker-compose.infra.yml"
ENV_FILE="$ROOT/.run/infra.env"
ENV_TRIAL_FILE="$ROOT/.env.trial"

MYSQL_PORT=${INFRA_MYSQL_PORT:-3306}
RUSTFS_API_PORT=${INFRA_RUSTFS_API_PORT:-9002}
RUSTFS_CONSOLE_PORT=${INFRA_RUSTFS_CONSOLE_PORT:-9003}

compose() { docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" "$@"; }

# ---- 凭据文件：不存在才生成（口令一旦生成保持稳定，勿删卷重复生成前先想清楚）--
gen_env_file() {
  [ -f "$ENV_FILE" ] && return 0
  command -v openssl >/dev/null 2>&1 || { echo "[infra] 需要 openssl 生成随机口令" >&2; exit 1; }
  mkdir -p "$(dirname "$ENV_FILE")"
  (
    umask 077
    {
      echo "# scripts/compose-infra.sh 生成于 $(date '+%F %T')；勿入库（.run/ 已 gitignore）"
      echo "INFRA_MYSQL_ROOT_PASSWORD=$(openssl rand -hex 16)"
      echo "INFRA_MYSQL_PASSWORD=$(openssl rand -hex 16)"
      echo "INFRA_MYSQL_RO_PASSWORD=$(openssl rand -hex 16)"
      echo "INFRA_RUSTFS_ACCESS_KEY=$(openssl rand -hex 10)"
      echo "INFRA_RUSTFS_SECRET_KEY=$(openssl rand -hex 16)"
    } > "$ENV_FILE"
  )
  chmod 600 "$ENV_FILE"
  echo "[infra] 已生成 $ENV_FILE（root / openvod / openvod_ro 口令与 RustFS AK/SK，权限 600）"
}

load_env_file() {
  [ -f "$ENV_FILE" ] || { echo "[infra] 缺少 $ENV_FILE：先执行 scripts/compose-infra.sh up" >&2; exit 1; }
  set -a
  . "$ENV_FILE"
  set +a
}

# ---- .env.trial：以根 .env 为底覆盖三个 DB 引导键；无根 .env 则生成必需最小集（ADR-0015）----
init_env_file() {
  load_env_file
  command -v openssl >/dev/null 2>&1 || { echo "[infra] 需要 openssl" >&2; exit 1; }
  body="$ENV_TRIAL_FILE.body"
  if [ -f "$ROOT/.env" ]; then
    # 其余键（MASTER_KEYS / 端口 / 兜底等）原样继承根 .env，去掉两个 DB 引导键与已废弃的 DELIVERY_DATABASE_URL
    grep -vE '^(DB_PROVIDER|DATABASE_URL|DELIVERY_DATABASE_URL)=' "$ROOT/.env" > "$body" || true
    # MASTER_KEYS 缺失或仍是 .env.example 全零占位时，替换为随机值（三端必须一致的真实密钥）
    if ! grep -q '^MASTER_KEYS=' "$body" || grep -qE '^MASTER_KEYS=.*0{64}' "$body"; then
      grep -vE '^MASTER_KEYS=' "$body" > "$body.x" || true
      mv "$body.x" "$body"
      printf 'MASTER_KEYS="1:%s"\n' "$(openssl rand -hex 32)" >> "$body"
    fi
    desc="根 .env 为底，覆盖两个 DB 键"
  else
    {
      echo "APP_ENV=\"dev\""
      echo "ADMIN_PORT=\"8787\""
      echo "DELIVERY_LISTEN=\":9000\""
      printf 'MASTER_KEYS="1:%s"\n' "$(openssl rand -hex 32)"
    } > "$body"
    desc="无根 .env，生成必需最小集（其余配置走管理台 /setup 向导）"
  fi
  {
    echo ""
    echo "# ---- 体验底座（openvod-infra 编排的本地 MySQL；凭据源 .run/infra.env）----"
    echo "DB_PROVIDER=\"mysql\""
    echo "DATABASE_URL=\"mysql://openvod:$INFRA_MYSQL_PASSWORD@127.0.0.1:$MYSQL_PORT/openvod\""
  } >> "$body"
  {
    printf '# scripts/compose-infra.sh init-env 生成于 %s（%s）\n' "$(date '+%F %T')" "$desc"
    echo '# 重复执行会整体重新生成，勿手改；改根 .env 或凭据后重新跑 init-env 即可'
    cat "$body"
  } > "$ENV_TRIAL_FILE"
  rm -f "$body"
  chmod 600 "$ENV_TRIAL_FILE"
  echo "[infra] 已生成 $ENV_TRIAL_FILE（$desc；全程未改动根 .env，已被 gitignore）"
  echo "[infra] 三端启动：bun scripts/dev.ts --env-file .env.trial all --background"
  echo "[infra] 建表迁移：task db:generate && (set -a && . ./.env.trial && set +a && task db:migrate)"
}

# ---- 等 mysql 健康（compose up 只保证容器在跑，首次初始化约 10~30s）----------
wait_mysql() {
  printf '[infra] 等待 mysql 健康'
  i=0
  while [ "$i" -lt 60 ]; do
    status=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' \
      "$(compose ps -q mysql)" 2>/dev/null || echo none)
    case $status in
      healthy) echo ' ok'; return 0 ;;
    esac
    printf '.'
    i=$((i + 1))
    sleep 2
  done
  echo ' 超时（最近日志：）'
  compose logs --tail=50 mysql >&2 || true
  exit 1
}

# ---- ADR-0011 受限账号（幂等；口令随 .run/infra.env 重生成而同步）------------
grant_delivery_account() {
  load_env_file
  compose exec -T mysql sh -c 'exec mysql -uroot -p"$MYSQL_ROOT_PASSWORD" --default-character-set=utf8mb4' <<SQL
CREATE USER IF NOT EXISTS 'openvod_ro'@'%' IDENTIFIED BY '$INFRA_MYSQL_RO_PASSWORD';
ALTER USER 'openvod_ro'@'%' IDENTIFIED BY '$INFRA_MYSQL_RO_PASSWORD';
ALTER USER 'openvod'@'%' IDENTIFIED BY '$INFRA_MYSQL_PASSWORD';
GRANT SELECT ON openvod.users TO 'openvod_ro'@'%';
GRANT SELECT ON openvod.media TO 'openvod_ro'@'%';
GRANT SELECT ON openvod.media_subtitles TO 'openvod_ro'@'%';
GRANT SELECT ON openvod.hls_keys TO 'openvod_ro'@'%';
GRANT SELECT ON openvod.signing_keys TO 'openvod_ro'@'%';
GRANT SELECT ON openvod.system_settings TO 'openvod_ro'@'%';
GRANT SELECT ON openvod.transcode_templates TO 'openvod_ro'@'%';
GRANT SELECT,INSERT,UPDATE,DELETE ON openvod.playback_sessions TO 'openvod_ro'@'%';
FLUSH PRIVILEGES;
SQL
  echo "[infra] 受限账号 openvod_ro 已就绪（ADR-0011：约定表只读 + playback_sessions 读写）"
}

print_info() {
  echo "[infra] MySQL     mysql://openvod:***@127.0.0.1:$MYSQL_PORT/openvod（root 与受限账号口令在 .run/infra.env）"
  echo "[infra] RustFS S3 http://127.0.0.1:$RUSTFS_API_PORT   控制台 http://127.0.0.1:$RUSTFS_CONSOLE_PORT（AK/SK 在 .run/infra.env）"
  echo "[infra] 下一步："
  echo "  1) sh scripts/compose-infra.sh init-env   生成 .env.trial（不动根 .env；连接串明细：scripts/compose-infra.sh env）"
  echo "  2) task db:generate && (set -a && . ./.env.trial && set +a && task db:migrate)"
  echo "  3) bun scripts/dev.ts --env-file .env.trial all --background（三端后台；日志 bun scripts/dev.ts logs all）"
  echo "  4) 管理台 /setup 向导：S3 参数填 RustFS（端点 http://127.0.0.1:$RUSTFS_API_PORT，桶先在控制台建，AK/SK 在 .run/infra.env）"
}

preview_url() {
  [ -n "${CNB_VSCODE_PROXY_URI:-}" ] || return 0
  printf '%s\n' "$CNB_VSCODE_PROXY_URI" | sed "s/{{port}}/$RUSTFS_CONSOLE_PORT/g"
}

cmd=${1:-up}
[ $# -gt 0 ] && shift || true

case "$cmd" in
  up)
    gen_env_file
    compose up -d
    wait_mysql
    grant_delivery_account
    compose ps
    print_info
    u=$(preview_url) || true
    if [ -n "${u:-}" ]; then
      echo "[infra] RustFS 控制台预览：$u（若打不开，在 WebIDE 的 PORTS 面板添加 $RUSTFS_CONSOLE_PORT）"
    fi
    ;;
  down)    load_env_file; compose down ;;
  reset)   load_env_file; compose down -v; echo "[infra] 已删除数据卷（本地 MySQL / RustFS 数据清空）" ;;
  ps)      load_env_file; compose ps ;;
  logs)    load_env_file; compose logs -f --tail=100 "$@" ;;
  restart) load_env_file; compose restart "$@" ;;
  init-env)
    init_env_file
    ;;
  env)
    load_env_file
    echo 'DB_PROVIDER="mysql"'
    echo "DATABASE_URL=\"mysql://openvod:$INFRA_MYSQL_PASSWORD@127.0.0.1:$MYSQL_PORT/openvod\""
    echo "# 需要分权部署时，delivery 进程可单独使用受限账号："
    echo "# mysql://openvod_ro:$INFRA_MYSQL_RO_PASSWORD@127.0.0.1:$MYSQL_PORT/openvod（口令见 .run/infra.env）"
    echo "# 空库首建表（prisma migrate dev 影子库）可用 root："
    echo "# mysql://root:$INFRA_MYSQL_ROOT_PASSWORD@127.0.0.1:$MYSQL_PORT/openvod"
    echo "# RustFS S3（/setup 向导）：endpoint=http://127.0.0.1:$RUSTFS_API_PORT  AK=$INFRA_RUSTFS_ACCESS_KEY  SK=$INFRA_RUSTFS_SECRET_KEY"
    echo "# 也可直接 sh scripts/compose-infra.sh init-env 生成 .env.trial（不动根 .env）"
    ;;
  url)
    u=$(preview_url) || true
    if [ -n "${u:-}" ]; then
      echo "$u"
    else
      echo "非 CNB 环境（无 CNB_VSCODE_PROXY_URI）：http://127.0.0.1:$RUSTFS_CONSOLE_PORT"
    fi
    ;;
  *)
    echo "用法：$0 {up|down|reset|ps|logs [服务]|restart [服务]|init-env|env|url}" >&2
    exit 2
    ;;
esac
