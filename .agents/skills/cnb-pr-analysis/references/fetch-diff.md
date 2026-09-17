# PR Diff 获取

获取 PR 代码变更差异，用于代码评审、变更总结等场景。

## 1. 判断场景并获取 SHA

### 场景 A：PR 评论触发（`CNB_PULL_REQUEST_IID` 存在）

直接从环境变量获取：head SHA 取 `CNB_PULL_REQUEST_SHA`，target SHA 取 `CNB_PULL_REQUEST_TARGET_SHA`。变量缺失时通过 API 查询 PR 详情。

> CI 只 clone 触发分支，**PR 另一端的 commit 通常不在本地**，两个场景都需执行下方「确保本地有 commit」。

### 场景 B：Issue 或其他场景引用 PR

1. 从用户输入解析 PR 编号（如 `!45`）
2. 通过 API 查询 PR 详情获取 SHA
3. 确保本地有对应 commit

### API 查询 PR 详情

```bash
# 查询 PR 详情，获取 head/base SHA 与分支 ref
pr_info=$(cnb pulls get-pull --repo "$CNB_REPO_SLUG" --number "${pr_iid}" --verbose)

head_sha=$(echo "$pr_info" | jq -r '.data.head.sha')
target_sha=$(echo "$pr_info" | jq -r '.data.base.sha')
head_ref="refs/pull/${pr_iid}/head"     # PR head 的合并 ref
base_ref=$(echo "$pr_info" | jq -r '.data.base.ref')  # 目标分支 ref，如 refs/heads/main
```

### 确保本地有 commit

```bash
# 0. 校验 SHA 非空：为空说明 API 查询失败或环境变量缺失，直接终止，避免落入兜底误判
[ -n "$head_sha" ]   || { echo "head_sha 为空，PR 查询失败" >&2; exit 1; }
[ -n "$target_sha" ] || { echo "target_sha 为空，PR 查询失败" >&2; exit 1; }

# 1. 先探测，本地已有就不拉。need 用空格分隔字符串以兼容 POSIX sh（勿用 bash 数组）
need=""
git cat-file -e "${head_sha}^{commit}"   2>/dev/null || need="$need $head_sha"
git cat-file -e "${target_sha}^{commit}" 2>/dev/null || need="$need $target_sha"

# 2. 优先按目标分支 ref / PR head ref 拉取：部分服务器未开启 allowAnySHA1InWant，
#    裸 SHA fetch 会被拒绝；ref 拉不到再降级为裸 SHA（探测命令的 2>/dev/null 是预期行为）
if [ -n "$need" ]; then
  git fetch -v --progress --force --no-recurse-submodules origin \
      "$base_ref" "$head_ref" 2>/dev/null \
    || git fetch -v --progress --force --no-recurse-submodules origin $need || true
fi

# 3. target 仍缺失时用 merge-base 兜底作 diff 基线，不要重试等待
if ! git cat-file -e "${target_sha}^{commit}" 2>/dev/null; then
  base=$(git merge-base "$head_sha" HEAD 2>/dev/null)
  # CI clone 的是触发分支，HEAD 可能就是 head_sha，此时 merge-base 会退化成
  # head 自己，三点 diff 变成空且退出码为 0，必须排除
  if [ -n "$base" ] && [ "$base" != "$head_sha" ]; then
    target_sha="$base"
  else
    echo "无法确定 diff 基线，请先拉取目标分支：git fetch -v --progress origin <target_branch>" >&2
  fi
fi
```

**硬性要求**：

**必须**：
- **带 `--progress`**：CI 非 tty 下 git 进度默认不输出（走 stderr），静默时大仓可能被看门狗 SIGKILL，`-v` 替代不了。

**禁止**：
- **屏蔽 fetch 输出**：`git fetch` 勿用 `2>/dev/null`、`| tail`、`> log`（探测命令 `git cat-file -e` 与「ref 探测降级」那次 fetch 除外）。
- **`--depth` / `--deepen`**：会写入 `.git/shallow` 切断祖先链，导致 `git merge-base` 和三点 diff 失败。CI 默认不限制深度，保持一致。
- **`sleep` 轮询等待 fetch**：探测失败直接走 `merge-base` 兜底。
- **`|| git fetch origin` 全量兜底**：大仓代价极高。

## 2. 获取 Diff

### 获取变更文件列表

```bash
git diff --name-only "${target_sha}...${head_sha}"
```

### 获取变更统计

```bash
git diff --stat "${target_sha}...${head_sha}"
```

### 获取完整 Diff

```bash
git diff -U5 "${target_sha}...${head_sha}"
```

### 获取特定文件的 Diff

```bash
git diff -U5 "${target_sha}...${head_sha}" -- path/to/file.ts
```

## 3. 过滤文件

按场景排除无需关注的文件：

**优先按「是否二进制」判断，而不是逐个后缀穷举**。逐后缀维护清单必然漏（`.webp`、
`.woff2`、`.wasm`、`.pdf` 等都不在旧清单里），漏掉的二进制文件仍会被拉进 diff 并在
评审/总结时按文本解析，产生乱码或误判。

`git diff` 本身不区分二进制，但可用 `git diff --numstat` 的输出过滤：二进制文件的
增删行数均为 `-`。先取文本文件清单，再按清单取 diff（含 NUL 字节的文件按二进制处理，
极少数小体积二进制可能被判为文本，此时按后缀兜底）：

```bash
# 1. 列出变更文件，并按 numstat 判定二进制（增删行数为 `-`）
git diff --numstat "${target_sha}...${head_sha}" | awk '$1!="-" && $2!="-" {print $3}'
```

如需用 pathspec 排除，**只保留确定性的路径与锁文件**（后缀清单仅作补充，不作为判据）：

```bash
git diff -U5 "${target_sha}...${head_sha}" -- . \
  ':!package-lock.json' ':!yarn.lock' ':!pnpm-lock.yaml' ':!go.sum' ':!Cargo.lock' \
  ':!dist/*' ':!build/*' ':!out/*' ':!node_modules/*' ':!vendor/*'
```

**建议排除**（判据是「非文本」，不是「后缀不在清单里」）：
- 锁文件：`package-lock.json`、`yarn.lock`、`pnpm-lock.yaml`、`go.sum`、`Cargo.lock`
- 构建产物：`dist/`、`build/`、`out/`、`target/`、`.next/`
- 依赖目录：`node_modules/`、`vendor/`、`.venv/`
- 压缩产物：`*.min.js`、`*.min.css`、`*.map`
- 图片、字体、压缩包、可执行文件等：由 `--numstat` 判定，不依赖固定后缀清单

## 4. 使用建议

1. **diff 过大**：先 `--name-only` 看文件列表，再按需取具体文件
2. **代码评审**：排除锁文件、构建产物、二进制文件
3. **变更总结**：可保留更多文件，但仍排除二进制与依赖目录
4. **不要因后缀不在清单里就跳过**：清单外的文件先按 `--numstat` 判定，确认是文本再纳入
5. **上下文行数**：默认 `-U5`，可按需调整

## 5. 对大 diff 的完整 diff 与按文件跳过

单文件或整体 diff 过大时，完整 diff 会超出单次可读范围：

- `git diff -U5 "${target_sha}...${head_sha}" -- <path>`：只取关心的文件，保持完整
  上下文，不要用 `--unified=0` 之类压缩换行数来换取覆盖度
- 仍然过长时按 hunk 定位：先 `--stat` 找出变更量最大的文件，逐个文件取，避免一次性
  拉全量后再截断
- 明确记录哪些文件被跳过，输出时说明范围，而不是让读者以为覆盖了全部变更
