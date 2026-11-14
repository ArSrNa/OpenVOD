#!/bin/sh
# 发版变更范围：本次 tag 相对上一个 tag 改了哪些文件 → 决定这次要重建哪几个镜像。
#
# 为什么不用 ifModify：CNB 只在 push / commit.add / PR 事件统计变更文件，tag_push 会直接
# 忽略 ifModify（语法手册：「上述支持事件以外，不适合统计文件变更，会忽略 ifModify 检查」）。
# 所以这里自己算 diff，输出 ##[set-output ...]，由 .cnb.yml 的 stage exports 注入环境变量，
# 再由 job / stage 的 if 决定跑不跑 —— 效果等价，且在 tag_push 上真的生效。
#
# 用法：
#   sh scripts/ci/changed-scope.sh                 # 当前 tag（CNB_BRANCH）对比上一个可达 tag
#   sh scripts/ci/changed-scope.sh <prev> <cur>    # 指定区间，本地排查用
#
# 输出：人读的变更清单 + 决策表，以及给 CNB 解析的
#   ##[set-output scope_worker=0|1]  … scope_admin / scope_delivery / scope_player / scope_sdk
#   ##[set-output retag_targets=worker,player]   本次没重建、需把上一版 tag 复制成本次版本 tag 的镜像
#   ##[set-output prev_tag=<tag>]                对比基线（空 = 没找到）
# 算不出基线（首个 tag、历史取不到）时退化为全量构建，不静默跳过。
set -eu

CUR=${2:-${CNB_BRANCH:-HEAD}}
PREV=${1:-}

FILES=$(mktemp)
trap 'rm -f "$FILES"' EXIT

echo "当前版本：$CUR"

# 浅克隆里既没有历史也没有 tag，对比不出东西：先补全（只抓元数据，不检出工作区文件）
if [ "$(git rev-parse --is-shallow-repository 2>/dev/null || echo false)" = "true" ]; then
  echo "检出为浅克隆，拉取完整历史与 tag"
  git fetch --unshallow --tags --quiet origin || echo "警告：拉取完整历史失败"
fi

# 当前版本对应的 commit；tag ref 缺失时退回 HEAD（检出为 tag 时两者等价）
CUR_REF=$CUR
if ! git rev-parse -q --verify "${CUR_REF}^{commit}" >/dev/null 2>&1; then
  CUR_REF=HEAD
fi

# 上一个发版点：从当前版本的父提交往前找最近的 tag（发版点都在主干上）
if [ -z "$PREV" ]; then
  PREV=$(git describe --tags --abbrev=0 "${CUR_REF}^" 2>/dev/null || true)
fi

ALL=0
if [ -z "$PREV" ]; then
  echo "__ALL__" >"$FILES"
  ALL=1
  echo "找不到上一个 tag → 全量构建"
elif ! git diff --name-only "$PREV" "$CUR_REF" >"$FILES" 2>/dev/null; then
  echo "__ALL__" >"$FILES"
  ALL=1
  echo "对比 $PREV → $CUR_REF 失败 → 全量构建"
else
  echo "对比基线：$PREV → $CUR，变更 $(wc -l <"$FILES" | tr -d ' ') 个文件"
  if [ -s "$FILES" ]; then
    head -n 40 "$FILES" | sed 's/^/  /'
    if [ "$(wc -l <"$FILES" | tr -d ' ')" -gt 40 ]; then
      echo "  …"
    fi
  fi
fi

scope() {
  if [ "$ALL" = "1" ]; then
    echo 1
  elif grep -qE "$1" "$FILES"; then
    echo 1
  else
    echo 0
  fi
}

# ── 路径分组：改这里 = 改「哪些改动会触发哪个镜像」 ──
# 三个 TS 镜像的构建上下文都是仓库根，共用 workspace 源码、锁文件与根 tsconfig。
# worker 只引 packages/{contracts,crypto,db,shared,storage,transcode}，不含 player-sdk（那是 admin / player 的依赖）
WORKER_PATHS='^(apps/worker/|packages/(contracts|crypto|db|shared|storage|transcode)/|bun\.lock$|tsconfig\.base\.json$|\.dockerignore$)'
# admin 把六个 workspace 包连同 openvod-jssdk 全引了，等于整个 packages/
ADMIN_PATHS='^(apps/admin/|packages/|bun\.lock$|tsconfig\.base\.json$|\.dockerignore$|package\.json$)'
# player 只引 openvod-jssdk（packages/player-sdk），不碰 @openvod/*
PLAYER_PATHS='^(apps/player/|packages/player-sdk/|bun\.lock$|tsconfig\.base\.json$|\.dockerignore$)'
# delivery 的构建上下文只有 apps/delivery（Go）；版本号由流水线以 build-arg 注入，故 package.json 也算依赖
DELIVERY_PATHS='^(apps/delivery/|package\.json$)'
SDK_PATHS='^packages/player-sdk/'

WORKER=$(scope "$WORKER_PATHS")
ADMIN=$(scope "$ADMIN_PATHS")
DELIVERY=$(scope "$DELIVERY_PATHS")
PLAYER=$(scope "$PLAYER_PATHS")
SDK=$(scope "$SDK_PATHS")

# 没重建的镜像：把上一版 tag 复制成本次版本 tag，保住「按 tag 回滚」
RETAG=""
if [ "$ALL" = "0" ] && [ -n "$PREV" ]; then
  if [ "$WORKER" = "0" ]; then RETAG="${RETAG}worker,"; fi
  if [ "$ADMIN" = "0" ]; then RETAG="${RETAG}admin,"; fi
  if [ "$DELIVERY" = "0" ]; then RETAG="${RETAG}delivery,"; fi
  if [ "$PLAYER" = "0" ]; then RETAG="${RETAG}player,"; fi
  RETAG=${RETAG%,}
fi

label() {
  if [ "$1" = "1" ]; then echo "构建"; else echo "跳过"; fi
}

echo
echo "构建决策（对比基线：${PREV:-无}）："
echo "  worker    $(label "$WORKER")"
echo "  admin     $(label "$ADMIN")"
echo "  delivery  $(label "$DELIVERY")"
echo "  player    $(label "$PLAYER")"
echo "  sdk       $(label "$SDK")"
if [ -n "$RETAG" ]; then
  echo "  未重建镜像补版本 tag：$RETAG"
fi

echo "##[set-output scope_worker=$WORKER]"
echo "##[set-output scope_admin=$ADMIN]"
echo "##[set-output scope_delivery=$DELIVERY]"
echo "##[set-output scope_player=$PLAYER]"
echo "##[set-output scope_sdk=$SDK]"
echo "##[set-output retag_targets=$RETAG]"
echo "##[set-output prev_tag=${PREV:-}]"
