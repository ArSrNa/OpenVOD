---
name: cnb-code-review
description: PR 代码评审，检查安全漏洞、Bug 和代码质量
---

# PR 代码评审

发现安全漏洞、Bug、代码质量和性能问题，通过 Review API 发送行级评审评论并提交评审结论。

## 评审步骤

### 1. 获取 PR 变更

读取 `cnb-pr-analysis` 的 `references/fetch-diff.md` 获取变更，按其「过滤文件」排除锁文件、
构建产物与二进制文件（二进制按 `--numstat` 判定，不按后缀清单穷举）。

**限制**：最多评审 30 个文件，diff 最大 100000 字符（超出截断）。

### 2. 分析代码

**评审重点**（按优先级降序）：

1. **安全漏洞**：注入、XSS、CSRF、硬编码凭证、敏感信息泄露、不安全加密
2. **潜在 Bug**：空指针、越界、并发、资源泄漏、异常处理不当
3. **代码质量**：可读性、命名、重复
4. **性能问题**：N+1 查询、低效算法、不必要 I/O

**评审原则**：
- 只评审新增代码（diff 中 `+` 开头的行，不含 `+++` 文件头）；删除、上下文及未修改的代码一律不评
- **忽略**：EOF 换行符、行尾空格、缩进风格（交 linter 处理）

**行号与上下文**：
- 新增代码的行号优先由 hunk 头 `@@ -a,b +c,d @@` 中的 `+c` 推算，`-U5` 已带必要上下文。
- 仅当 diff 不足以理解变更或无法推算行号时，才读源文件，按「理解变更所需的最小上下文」控制范围与次数，避免整文件通读与反复回读。

### 3. 输出评审结果

**分析完全部文件后，一次性输出完整 JSON**（不要逐文件、逐条生成后再拼接），再进入第 4 步**一次请求**发送。

**严格输出以下 JSON**：

```json
{
  "status": "passed | needs_modification | critical",
  "issues": [
    {
      "severity": "critical | warning | info",
      "file": "文件路径",
      "start_line": 起始行号, "end_line": 结束行号,
      "problem": "问题描述", "suggestion": "修复建议"
    }
  ]
}
```

**字段说明**：
- `status`：`passed` 通过 / `needs_modification` 需修改 / `critical` 存在严重问题
- `severity`：`critical` 严重（安全漏洞、崩溃 Bug）/ `warning` 潜在问题 / `info` 改进建议
- `start_line` / `end_line`：问题代码行号范围（新文件行号）
- `problem` / `suggestion`：Markdown 格式，用 \`代码\` 标记标识符、代码块展示修复示例
- **无问题时**：`issues` 为空数组 `[]`

### 4. 提交评审

按第 5 章选定 `--event`，把第 3 步的 `issues` 作为**行级评审评论**，与结论放在**同一次请求**里发送：
`--comments-*` 带行级评论；`issues` 为空时只传 `--event` 与 `--body`。

仓库名与 PR 编号分别从 `CNB_REPO_SLUG`、`CNB_PULL_REQUEST_IID` 环境变量获取，
快捷命令已自动读取，`--repo` / `--number` 可省略（跨仓库时需显式传入）。

```bash
cnb pulls submit-review \
  --event request_changes \
  --body '**评审结果**: 需要修改，详见行级评论。' \
  --comments-path "src/main.ts" \
  --comments-start-line 12 \
  --comments-start-side right \
  --comments-end-line 14 \
  --comments-end-side right \
  --comments-subject-type line \
  --comments-body '问题: ...
建议: ...' \
  --comments-path "src/util.ts" \
  --comments-start-line 30 \
  --comments-start-side right \
  --comments-end-line 30 \
  --comments-end-side right \
  --comments-subject-type line \
  --comments-body '问题: ...
建议: ...'
```

命令参数要点：
- 每组的 `--comments-path`、`--comments-start-line`、`--comments-end-line`、
  `--comments-subject-type`、`--comments-body` 必须齐全，缺失会报 400。
- 多个问题**重复传参**，参数间按出现顺序对齐；不要合成数组或 JSON 字符串。
- 行级评论的侧别固定 `right`（新代码侧），行号取新文件行号。
- `--body` 与 `--comments-body` 支持多行，用单引号包裹。
- 提交失败时可降级为 `cnb pulls comment --body '...'` 发送普通评论；**不要**降级为再调用一次
  `submit-review`，那会产生第二条评审记录。

---

## 5. 评审结论决策

评审的输入是第 3 步的 `status`，输出是一次 `submit-review` 的 `--event` 取值。
三个取值不是「优劣」关系，而是三种**语义不同**的信号，按语义选、不要按习惯选。

### 5.1 三者区别

| 取值              | 信号         | 对 PR 的作用             | 阻塞合并 | 何时用                       |
| ----------------- | ------------ | ------------------------ | -------- | ---------------------------- |
| `approve`         | 批准         | 记为「批准」             | 否       | 认可这份改动，可以合         |
| `request_changes` | 请求修改     | 记为「请求修改」         | 是       | 有必须改完才能合的问题       |
| `comment`         | 仅评论       | 只留意见，不改判定状态   | 否       | 有价值要说，但本轮不下判定   |

三者都会**新增一条评审记录**（不更新旧记录），因此后一次调用会覆盖前一次在该 PR 上的结论状态。

### 5.2 使用场景

**`approve`** — 认可改动。`status` 为 `passed`，或只有可选优化且不阻塞合并。
有建议时照常写行级评论，结论仍用 `approve`，并在 `--body` 说明不阻塞。

**`request_changes`** — 有必修项。`status` 为 `needs_modification` 或 `critical`。
不要把「提了意见」等同于「请求修改」：意见是否**必须改完才能合**，才是这条分界线。

**`comment`** — 值得留意见，但本轮不给判定。它不是「兜底」或「降级选项」，是正常的评审产出，
以下场景都该用：

- **提问与澄清**：对设计意图、边界条件有疑问，需作者回答后才能判定；
- **增量评审**：只看了部分文件、diff 被截断、关键上下文缺失，本轮先给局部意见；
- **非阻塞建议**：架构风格、命名偏好、后续优化方向，不影响本次合并；
- **信息补充**：说明测试/复现情况、贴出参考实现、同步评审进展。

用 `comment` 后，PR 不会被批准也不会被拒绝，作者可以继续推进，也不会把之前的结论状态误标成通过。

> **判定顺序**：
> 1. 有必须改完才能合的问题？→ `request_changes`
> 2. 没有，且认可改动可以合？→ `approve`
> 3. 其余情况（要问、要补、只是建议）→ `comment`
>
> 关键约束：先确认上述 1、2 是否成立。若成立，**不能**因为「只想留条评论」而用 `comment`；
> 若都不成立，才用 `comment`——而不是因为它更「轻」。

### 5.3 覆盖策略

同一个 PR 上，同一用户的结论状态由**最后一次** `submit-review` 的 `--event` 决定：

- 每次 `submit-review` 都是**新增**一条评审记录，不更新旧记录。
- 所以**后一次 `comment` 会把前一次 `approve` / `request_changes` 覆盖掉**
  （#368 现象：先 `approve` 又补 `comment`，最终态变成「仅评论」）。
- 结论类（`approve` / `request_changes`）每 PR **只提交一次**；
  结论与行级评论放**同一次**请求，不要先发评论再补结论。
- 只需追加说明、且**不影响已有结论**时，用普通评论 `cnb pulls comment`——
  它不进评审记录，也就不会覆盖结论。
- 提交后可用 `cnb pulls list-reviews` 核对（`approved` / `changes_requested` /
  `commented`），核对应在提交后一次完成，不做轮询等待。

---

## 6. 三种结论的用法

### 6.1 `approve`

```bash
cnb pulls submit-review \
  --event approve \
  --body '**评审结果**: 通过

代码质量良好，未发现明显问题。'
```

- 有行级评论时与 `--comments-*` 一次提交；无问题时只传 `--event` 与 `--body`。
- 有可选建议时结论仍用 `approve`，在 `--body` 注明不阻塞合并；补充说明走 `cnb pulls comment`。

### 6.2 `request_changes`

完整参数示例见第 4 步，本节是精简形态：

```bash
cnb pulls submit-review \
  --event request_changes \
  --body '**评审结果**: 需要修改，详见行级评论。' \
  --comments-path "src/main.ts" \
  --comments-start-line 12 \
  --comments-start-side right \
  --comments-end-line 12 \
  --comments-end-side right \
  --comments-subject-type line \
  --comments-body '问题: ...
建议: ...'
```

- 每条问题都要给出**原因**与**修复建议**，让作者能直接改。
- 行级评论有数量上限（见「约束速查」），超限时优先保留严重问题，其余在 `--body` 概述。

### 6.3 `comment`

`comment` 有两种落点，按「是否要进评审记录」选择：

**进评审记录**——在评审上下文中留痕，但不改判定状态，适合提问、增量评审、非阻塞建议：

```bash
cnb pulls submit-review \
  --event comment \
  --body '**评审说明**: 有两点想问作者确认。

1. ...
2. ...'
```

**不进评审记录**——普通 PR 评论，适合补充说明、答复提问、进展同步：

```bash
cnb pulls comment --body '补充说明：...'
```

- `comment` 是正常的评审产出，别为「保险」一律用它，也别因「有意见」就一定
  `request_changes`——按 5.2 的分界线判断。

## 约束速查

### 必须
- 行号对应 diff **新文件行号**（右侧），推算方法见「行号与上下文」
- 每条评论包含问题原因与修复建议
- 按第 5 章判定 `--event`：有必修项用 `request_changes`，认可改动用 `approve`，其余用 `comment`

### 限制
- 最多 10 条评论，按严重程度优先（critical > warning > info）
- 每 PR 只提交一次结论，提交后如需补充说明用 `cnb pulls comment`（详见第 5.3 节）
- 一次拉取 diff → 集中分析 → 一次输出 → 评论与结论合并为一次请求发送
- 不做任何轮询或 `sleep` 等待操作（如循环 `check-status`、`sleep` 重试等）
