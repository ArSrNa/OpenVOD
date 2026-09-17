#!/usr/bin/env sh
# =============================================================================
# gen-env.sh — 从「环境变量」生成 .env
#
# .env 已被 .gitignore，真源是 CNB 密钥仓库：云原生开发启动时由 .cnb.yml 的
# imports 注入环境变量，再用本脚本把变量落回 .env（start.sh / Taskfile 照旧读取）。
#
# 用法：
#   scripts/gen-env.sh                 生成 <root>/.env（已存在则跳过）
#   scripts/gen-env.sh --force         覆盖已存在的 .env（密钥轮换后用）
#   scripts/gen-env.sh --stdout        只打印结果，不落盘（排查用）
#   scripts/gen-env.sh --check         只校验必需变量是否齐全/是否还是占位值
#   scripts/gen-env.sh -o apps/admin/.env -t .env.example
#
# 取值来源（前者优先）：
#   1) 整体：OPENVOD_ENV_B64 —— 完整 .env 内容的 base64（base64 -w 0 < .env）
#   2) 逐项：以 .env.example 为模板，用当前环境变量覆盖同名 KEY；
#      模板里没有的键用 EXTRA_ENV_KEYS 追加（逗号分隔），
#      例：EXTRA_ENV_KEYS=MYSQL_ROOT_PASSWORD,MYSQL_PASSWORD scripts/gen-env.sh
#
# 可调环境变量：
#   ENV_FILE / TEMPLATE / EXTRA_ENV_KEYS / REQUIRED_KEYS / STRICT=1（校验失败退出 1）
# =============================================================================
set -eu

ROOT=$(cd "$(dirname "$0")/.." && pwd)
ENV_FILE=${ENV_FILE:-$ROOT/.env}
TEMPLATE=${TEMPLATE:-$ROOT/.env.example}
REQUIRED_KEYS=${REQUIRED_KEYS:-"DB_PROVIDER DATABASE_URL MASTER_KEYS URL_SIGN_KEY_HEX BETTER_AUTH_SECRET"}
FORCE=0
STDOUT=0
CHECK=0

usage() { sed -n '2,26p' "$0" | sed 's/^#\{1,\} \{0,1\}//'; }

while [ $# -gt 0 ]; do
  case "$1" in
    -f|--force)     FORCE=1 ;;
    -o|--out)       ENV_FILE=$2; shift ;;
    -t|--template)  TEMPLATE=$2; shift ;;
    --stdout)       STDOUT=1 ;;
    --check)        CHECK=1 ;;
    -h|--help)      usage; exit 0 ;;
    *) echo "未知参数：$1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

# base64 解码（GNU: -d / BSD: -D）
b64_decode() {
  if printf 'aGVsbG8=' | base64 -d >/dev/null 2>&1; then
    printf '%s' "$1" | base64 -d
  else
    printf '%s' "$1" | base64 -D
  fi
}

# 统一用双引号包裹并转义，避免空格 / $ / 反引号 / 引号破坏 .env 与 source
quote_val() {
  printf '"%s"' "$(printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g; s/\$/\\$/g; s/`/\\`/g')"
}

# 取环境变量值（key 已校验为 [A-Za-z0-9_]+）
env_val() { eval "printf '%s' \"\${$1-}\""; }

# ---- 模式 2：模板 + 环境变量覆盖 --------------------------------------------
render_template() {
  [ -f "$TEMPLATE" ] || { echo "错误：模板不存在：$TEMPLATE" >&2; exit 1; }
  while IFS= read -r line || [ -n "$line" ]; do
    case $line in
      export\ *) line=${line#export } ;;
    esac
    case $line in
      ''|\#*) printf '%s\n' "$line"; continue ;;
    esac
    key=${line%%=*}
    case $key in
      *[!A-Za-z0-9_]*) printf '%s\n' "$line"; continue ;; # 非 KEY=VALUE 行原样保留
    esac
    val=$(env_val "$key")
    if [ -n "$val" ]; then
      printf '%s=%s\n' "$key" "$(quote_val "$val")"
    else
      printf '%s\n' "$line" # 环境未注入 → 沿用模板默认值
    fi
  done < "$TEMPLATE"

  if [ -n "${EXTRA_ENV_KEYS:-}" ]; then
    printf '\n# ---- 额外键（EXTRA_ENV_KEYS）----\n'
    printf '%s\n' "$EXTRA_ENV_KEYS" | tr ',' '\n' | while IFS= read -r key; do
      key=$(printf '%s' "$key" | tr -d ' \t')
      [ -n "$key" ] || continue
      val=$(env_val "$key")
      [ -n "$val" ] || { echo "警告：EXTRA_ENV_KEYS 中的 $key 在环境中无值，已跳过" >&2; continue; }
      printf '%s=%s\n' "$key" "$(quote_val "$val")"
    done
  fi
}

# ---- 校验：必需项 / 占位值（只报变量名，不打印值）---------------------------
check_env_file() {
  [ -f "$ENV_FILE" ] || { echo "MISSING_FILE $ENV_FILE"; return 0; }
  (
    set -a; . "$ENV_FILE" 2>/dev/null; set +a
    for k in $REQUIRED_KEYS; do
      eval "v=\${$k-}"
      [ -n "$v" ] || echo "缺失必需变量 $k"
    done
    # 占位值检测：这些值在 .env.example 里是示例，落到开发环境会导致两端密钥不一致
    case "${MASTER_KEYS-}" in
      *:0000000000000000000000000000000000000000000000000000000000000000*) echo "MASTER_KEYS 仍是 .env.example 占位值" ;;
    esac
    case "${URL_SIGN_KEY_HEX-}" in
      1111111111111111111111111111111111111111111111111111111111111111|0000000000000000000000000000000000000000000000000000000000000000) echo "URL_SIGN_KEY_HEX 仍是 .env.example 占位值" ;;
    esac
    case "${BETTER_AUTH_SECRET-}" in
      *please-generate*) echo "BETTER_AUTH_SECRET 仍是 .env.example 占位值" ;;
    esac
    case "${DATABASE_URL-}" in
      *changeit*) echo "DATABASE_URL 仍是 .env.example 占位密码" ;;
    esac
  )
}

if [ "$CHECK" = 1 ]; then
  report=$(check_env_file) || true
  if [ -n "$report" ]; then
    printf '%s\n' "$report" | sed 's/^/[gen-env] /' >&2
    [ "${STRICT:-0}" = 1 ] && exit 1
    exit 0
  fi
  echo "[gen-env] $ENV_FILE 必需变量齐全"
  exit 0
fi

# ---- 生成 -------------------------------------------------------------------
if [ -n "${OPENVOD_ENV_B64:-}" ]; then
  content=$(b64_decode "$OPENVOD_ENV_B64")
  src="OPENVOD_ENV_B64（密钥仓库整体注入）"
else
  content=$(render_template)
  src="模板 $TEMPLATE + 环境变量覆盖"
fi

if [ "$STDOUT" = 1 ]; then
  printf '%s\n' "$content"
  exit 0
fi

if [ -f "$ENV_FILE" ] && [ "$FORCE" != 1 ]; then
  echo "[gen-env] $ENV_FILE 已存在，跳过（用 --force 覆盖）"
else
  printf '%s\n' "$content" > "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  echo "[gen-env] 已生成 $ENV_FILE（来源：$src，$(printf '%s\n' "$content" | grep -c '[^[:space:]]') 行，权限 600）"
fi

report=$(check_env_file) || true
if [ -n "$report" ]; then
  printf '%s\n' "$report" | sed 's/^/[gen-env] 警告：/' >&2
  if [ "${STRICT:-0}" = 1 ]; then exit 1; fi
fi
