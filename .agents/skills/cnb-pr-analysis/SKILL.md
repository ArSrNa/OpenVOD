---
name: cnb-pr-analysis
description: 获取 PR diff 变更并总结 PR 内容，概述主要改动点、生成变更说明
---

# PR 变更获取与分析

PR 变更场景的入口：**取变更**（diff）与**总结变更**是一件事的前后半程，本 skill 内一次走完。

## 模式判定

- **取变更模式**（看某个 PR 改了什么、要 diff / 文件列表 / 变更统计）→ 走「变更获取流程」
- **总结模式**（总结 PR 变更、概述改动内容、生成变更说明）→ 走「变更获取流程」→「总结流程」
- **代码评审**（审查安全/Bug/质量）→ 用 `cnb-code-review`，它复用本 skill 的 `references/fetch-diff.md` 取变更

## 变更获取流程

1. **确定 PR 与场景** -- PR 评论触发时 PR 编号取 `CNB_PULL_REQUEST_IID`；Issue/对话中引用 PR 时从输入解析编号（如 `!45`）。
2. **拿到两端 SHA** -- 按场景从环境变量或 API 取 head / target SHA，并确保本地有对应 commit（含 fetch 兜底链）。
3. **取 diff** -- 先 `--name-only` / `--stat` 看规模，再按需取具体文件；排除锁文件、二进制、构建产物。
4. **大 diff 处理** -- 变更文件数超过 20 个时先看分布，按模块归类，只详读核心模块。

> 完整命令（SHA 解析、fetch 兜底、`merge-base` 退化判据、排除清单、硬性要求）见 `references/fetch-diff.md`。

## 总结流程

1. **取变更信息** -- 按「变更获取流程」拿到 `--stat` 与 `--name-only`，再按需取关键文件 diff。
2. **分析变更** -- 按文件优先级筛选核心代码，从变更类型（feat / fix / refactor / perf / docs / chore）、
   影响范围、关键改动、破坏性变更四个维度分析；上下文不足时读完整源文件。
3. **按格式输出** -- 输出格式与总结原则见 `references/summary-guide.md`，按其组织内容。

## 详细参考文档

- `references/fetch-diff.md`：SHA 解析、fetch 兜底链、diff 命令与文件过滤、硬性要求（禁止 `--depth`、禁止屏蔽 fetch 输出等）
- `references/summary-guide.md`：总结模式的文件优先级、分析维度、输出格式、总结原则、大型 PR 处理
