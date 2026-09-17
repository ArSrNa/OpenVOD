---
name: cnb-code-commit
description: 编写代码、提交并创建 PR，含 PR 标题/描述/提交规范
---

# 自动编码并提交推送

两种流程，按场景选：
1. 新建分支 → 编写代码 → 推送 → 创建 PR
2. 切到 PR 源分支 → 编写代码 → 推送更新 PR

## 步骤

### 1. 理解需求

明确改动文件、功能/Bug 描述、PR base；必要时读工作区代码或 PR diff。

### 2. 准备分支

- **PR 评论触发**（`CNB_PULL_REQUEST_IID` 存在）：切到源分支继续改
  ```bash
  git checkout "$CNB_PULL_REQUEST_BRANCH"
  git pull origin "$CNB_PULL_REQUEST_BRANCH"
  ```
- **ISSUE 触发且 PR 已存在**：`git checkout <PR 源分支名> && git pull`
- **ISSUE 触发且无 PR**：基于目标分支新建分支，命名遵循项目约定；项目无约定时用
  `auto/{关键词}-{随机后缀}`，例：`auto/optimize-skill-3a7f`
  ```bash
  git checkout -b "auto/{关键词}-$(openssl rand -hex 2)"
  ```

### 3. 编写代码

直接改文件，遵循项目风格，确保 import/依赖完整。改 `.cnb.yml` 时参照 cnb-pipeline 技能，
提交前必须通过其校验。

### 4. 验证与提交

```bash
git diff --stat        # 变更概览
# 如有构建/lint 命令则执行验证
git add -A
git commit -m "{类型}: {简短描述}"
```

类型：`feat` / `fix` / `refactor` / `docs` / `chore`

### 5. 推送并判断是否已有 PR

```bash
git push origin HEAD
```

- 输出含 `There is already has pull request` → **已有 PR**：不再创建，评论告知用户
- 输出含 `Create a pull request` 或 `new branch` → **无 PR**：走第 6 步

### 6. 创建 PR 即结束

```bash
cnb pulls post-pull --repo "$CNB_REPO_SLUG" \
  --base "$CNB_DEFAULT_BRANCH" \
  --head "$(git branch --show-current)" \
  --title "{类型}: {简短描述}" \
  --body '<pr-body>'
```

`cnb pulls post-pull` 成功后立即结束。

## PR 规范

> 默认约定，项目另有规定时以项目规定为准。

### 标题

- 一行表达，语义化提交格式，只保留核心问题，简洁可读
- 保持标题纯净：补充说明、目标分支、版本号、日期、作者、关联编号等附加信息一律写描述区，
  不进标题

### 描述

- 开头写变更背景、要解决的问题、改动点与验证方式
- 若本次改动关联 Issue，须含 `Ref: #<ISSUE_ID>`（如 `Ref: #11`），否则 Issue 看不到关联 PR
- 附加信息写描述区：版本号、日期、作者，以及 cherry-pick 场景的 `cherry-pick #xxx`、
  pick 意图说明、目标版本（写 body 末尾）

### pick / cherry-pick 场景

- 标题体现**本次代码变更的原始意图**，直接采用**原提交注释的标题**
- 不得在标题出现 `pick` / `cherry-pick` / `pick xxx to xxx` 等 pick 意图描述，这些写描述区

## 约束速查

### 必须
- 关联 Issue 时 PR body 含 `Ref: #<ISSUE_ID>`
- pick / cherry-pick 场景的标题规则见「pick / cherry-pick 场景」
- PR 不存在时先建分支再提交，不在默认分支上改代码
- `--body` 用单引号包裹，用**真换行**拼接，避免 `\n` 字面量与 shell 转义

### 禁止
- **不得主动指定 git 身份**：环境已配好提交身份，直接 `git commit -m "..."` 即可；
  不要 `git config user.name/user.email`、`git commit --author=...`，
  也不要无条件使用 `git -c user.name=... -c user.email=... commit`
- `git push --force`（除非用户明确要求；需覆盖时用 `--force-with-lease`）
- 创建/推送 PR 后轮询或等待 CI、评审状态（失败会自动唤起 NPC）
- 合并/关闭 PR：AI 只负责提交 PR，不执行 `merge` / `cnb pulls merge`，合并交由人工

### 例外
- 仅当 `git commit` 因缺失 identity 失败时，才允许用
  `git -c user.name=... -c user.email=... commit` 兜底，并在 PR 描述中说明

### 建议
- 先理解项目结构与代码风格再动手；不修改无关文件，推送前确认变更正确
- 需求不明确或范围过大时，先评论确认再执行
