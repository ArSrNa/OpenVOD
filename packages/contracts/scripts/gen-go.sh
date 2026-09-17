#!/usr/bin/env bash
# JSON Schema → Go struct（quicktype，生成物提交入库 + CI git diff 门禁，ADR-0001）
set -euo pipefail
cd "$(dirname "$0")/../../.."

command -v quicktype >/dev/null 2>&1 || {
  echo "quicktype 未安装（见 .ide/Dockerfile：npm i -g quicktype）" >&2
  exit 1
}

out_dir="apps/delivery/internal/contracts"
mkdir -p "$out_dir"
rm -f "$out_dir"/*.go

for f in packages/contracts/jsonschema/*.json; do
  name="$(basename "$f" .json)"
  quicktype --src-lang schema --lang go \
    --top-level "$name" --package contracts \
    --just-types-and-package \
    -o "$out_dir/${name}.go" "$f"
  echo "gen  $out_dir/${name}.go"
done

echo "完成。生成物已入库，变更需提交（CI: bun run check:contracts-go）"
