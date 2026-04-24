---
name: best-of-both-worlds
description: "This skill should be used when the user asks to merge `caozhiyuan/all` into `czy-all`, push `czy-all`, create a PR from `czy-all` to `dev`, or resolve merge conflicts one by one by combining the best parts of both branches."
---

# Best of Both Worlds

把 `caozhiyuan/all` 的最新内容带到本仓库的 `czy-all`，再向 `dev` 发起 PR；若 PR 出现冲突，不要一把梭接受单边，而要逐个冲突块分析，尽量取两边之长。

## 适用场景

当用户提出类似下面这些请求时，使用此 skill：

- “merge caozhiyuan/all to czy-all”
- “push czy-all”
- “raise pr from czy-all to dev”
- “resolve the pr conflicts one by one”
- “best of both worlds”
- “把 caozhiyuan/all 同步到 czy-all 再 PR 到 dev”

## 核心原则

### 分支职责（硬规则）

- `remotes/caozhiyuan/all`：上游来源分支（对方仓库）。
- `czy-all`（tracking `origin/czy-all`）：本仓库的**镜像/承接分支**，用于保持与 `caozhiyuan/all` 同步，并作为 PR 源头。
- `dev`：本仓库目标集成分支。

默认目标是：

1. 先把 `caozhiyuan/all` 同步到 `czy-all`（只在 `czy-all` 上操作）
2. 再把 `czy-all -> dev`

**禁止默认做法：**

- 未经用户明确要求，不得执行 `dev -> czy-all`（例如在 `czy-all` 上 merge `dev`）。
- 未经用户明确要求，不得把 `czy-all` 当作日常开发分支写入与同步目标无关的提交。

> 解释：`czy-all` 的职责是保持“可从 `caozhiyuan/all` 干净同步”的状态；反向混入 `dev` 会污染同步基线。

1. **保持 tracking 不乱改。** 除非用户明确要求，不要擅自把 `czy-all` 的 upstream 从 `origin/czy-all` 改到别的远端。
2. **把“拉内容”和“改 tracking”分开。** 需要同步 `caozhiyuan/all` 时，直接 `git pull caozhiyuan all` 或等价操作；不要顺手重写 upstream。
3. **PR 方向固定。** 这条工作流里，PR 默认是 `czy-all -> dev`。
4. **冲突逐个解，不批量糊。** 出现 PR conflict 后，不要直接全选 ours/theirs，不要一次性大面积接受某一边。
5. **优先保留两边有效意图。** 目标不是“偏向哪边”，而是“best of both worlds”。
6. **冲突决定权在用户。** agent 负责把每个冲突拆成可理解的选项、说明影响并执行用户决定；不要替用户拍板。
7. **先报数量，再解冲突。** agent 应先告诉用户一共有多少冲突文件、多少冲突块，再进入逐个处理。
8. **处理过程中持续播报。** 每解决一块或推进到下一文件时，都要让用户知道当前进度，不要闷头解到最后。
9. **先讲非冲突改动的价值。** 在进入冲突决策前，agent 应先告诉用户这批不冲突改动分别带来了什么功能变化、面向什么 use case。

## 标准流程

### 第一步：确认当前状态

先确认：

- 当前分支是否是 `czy-all`
- 工作树是否干净
- `czy-all` 当前是否继续跟踪 `origin/czy-all`
- `caozhiyuan/all` 是否可 fetch / pull

再做一次方向检查（必须明确回答）：

- 本次是否在执行 `czy-all -> dev`？
- 当前操作是否会把 `dev` 反向写入 `czy-all`？

若第二问答案是“会”，且用户未明确要求，则应立即停止并改回正确流程。

推荐命令：

```bash
git status --short
git branch -vv
git remote -v
git fetch caozhiyuan
```

### 第二步：把 `caozhiyuan/all` 带进 `czy-all`

在 `czy-all` 上执行同步，但**不要改变 `czy-all` 的 tracking**。

推荐做法：

```bash
git checkout czy-all
git pull --ff-only caozhiyuan all
```

若不是 fast-forward，再进入正常 merge / rebase 判断，但不要先改 upstream。

### 第三步：推送 `origin/czy-all`

把本地 `czy-all` 推到当前仓库 fork：

```bash
git push origin czy-all
```

### 第四步：创建 PR（`czy-all -> dev`）

使用 `gh` 创建 PR：

```bash
gh pr create --base dev --head czy-all
```

PR 标题和摘要要围绕**这次从 `caozhiyuan/all` 带来的真实变更**，不要只写一句泛泛的 sync branch。

生成 PR 摘要时，先看：

```bash
git log --oneline dev..czy-all
git diff --stat dev...czy-all
```

## 冲突处理：逐块走 “best of both worlds”

如果 PR 出现冲突，按**文件 → 冲突块**逐个处理。

### 每个冲突块都必须回答这 4 个问题

1. `dev` 这一边保留了什么意图？
2. `czy-all` 这一边带来了什么新能力或修复？
3. 两边是否能组合，而不是二选一？
4. 如果不能自动判断，哪一点需要用户拍板？

### 决策权限规则

面对冲突时，agent 应遵守以下规则：

- **用户决定，agent 执行**
- agent 可以整理 `dev` 侧与 `czy-all` 侧的意图、风险与推荐组合方案
- agent 可以指出哪种组合更像 “best of both worlds”
- **但最终保留哪边、怎么拼，必须由用户拍板**
- 如果用户还没拍板，agent 不要擅自完成该冲突块的最终取舍

### 执行门禁（强制，不可绕过）

在对每个冲突块落地任何操作（写文件、标记已解决、进入下一块）之前，必须同时满足以下全部条件：

1. 主 agent 已给出本块的对比分析与推荐方案；
2. sub-agent 已返回独立意见（若本轮启用了 sub-agent）；
3. 用户对**当前块编号**给出明确确认（如”yes / agree / 执行方案 A”）。

**三方对齐 = 信息齐全。用户拍板 = 唯一执行许可。两者不能混用。**

> 看到”三方意见一致”或”两边建议相同”，**不构成执行授权**。必须等用户说话。

执行前，agent 必须先说出这句话（verbatim preflight）：

```text
确认：你已对第 X 块给出明确拍板（原话：”...”），现在才执行。
```

若无法填入用户的原话，则还没有授权，禁止执行。

### Sub-Agent 独立意见格式

每次调用 sub-agent 时，要求它按以下结构输出（在 prompt 中明确要求）：

```text
[Sub-agent 独立意见 | Block X/Y]
dev 意图：
czy-all 意图：
推荐组合：
风险/不确定点：
是否需要用户拍板：是（固定）
```

最后一行必须固定为”是（固定）”，防止主 agent 误读为”已可执行”。

### 冲突数量与进度播报规则

在开始逐块处理前，agent 应先向用户明确：

- 当前一共有多少个冲突文件
- 当前一共有多少个冲突块
- 每个文件各有多少块冲突

推荐话术：

```text
当前共有 X 个冲突文件、Y 个冲突块。
我会一次只带你看一个冲突块，并在每推进一块后告诉你还剩多少。
```

在处理过程中，agent 应持续播报类似下面的信息：

```text
第 1 块已按你的决定落下，当前还剩 2 个文件、2 个冲突块。
现在进入下一个冲突。
```

不要等全部冲突都处理完才一次性汇报结果。

### 非冲突改动说明规则

在开始逐块处理冲突前，agent 还应先整理：

- 哪些文件改动是**不冲突**的
- 这些不冲突改动分别带来了什么功能变化
- 这些变化分别服务于什么 use case / 用户场景

推荐话术：

```text
先说不冲突的部分：这批改动里，已有 A 个文件可以直接收下。
它们带来的变化主要是：
1. <功能变化> —— 对应 <use case>
2. <功能变化> —— 对应 <use case>

在这个背景上，我们再进入冲突块决策。
```

不要一上来只报冲突，不解释“这批 PR 整体想带来什么能力变化”。

### 建议输出模板

面对每一个冲突文件，先整理成：

```text
文件：<path>

dev 侧：
- 保留了什么
- 解决了什么问题

czy-all 侧：
- 引入了什么
- 修复了什么问题

推荐解法：
- 保留 dev 的哪些部分
- 合并 czy-all 的哪些部分
- 为什么这样是 best of both worlds

需要用户确认：
- 仅列真正有歧义的点
```

### 用户 brainstorming 规则

如果冲突带有明显产品/行为取舍，不要直接拍板。要先和用户 brainstorm，再改代码。

适合先问用户的问题包括：

- 两边行为是否都必须保留？
- 哪一边是近期修复，哪一边是老分支特性？
- 用户更在意兼容性、行为稳定，还是新功能？

默认话术应接近下面这种风格：

```text
这个冲突我不替你决定。
我先把 dev 侧、czy-all 侧、以及可组合方案拆开；你拍板选哪一种，我再按你的决定去改。
```

## 明确禁止的做法

- 不看 diff 就直接 `ours` / `theirs`
- 因为冲突多就一次性全文件接受单边
- 把”跟踪谁”与”拉谁的内容”混为一谈
- 未经用户明确要求，在 `czy-all` 上执行 `merge dev` / `rebase dev` 之类反向写入
- 把 `czy-all` 当作长期开发分支，写入与”同步 caozhiyuan/all + 提 PR 到 dev”无关的改动
- 没有先 push `origin/czy-all` 就开 PR
- PR 摘要不看实际提交和 diff，胡乱概括
- **看到 sub-agent 意见与自身建议相同，就以”三方对齐”为由直接执行** — 这是最常见的违规，必须明确禁止
- **用户在 sub-agent 未返回前说了”yes”，就以此为授权执行** — 必须等 sub-agent 返回后让用户做最终确认

## 快速检查清单

在结束前，确认：

- `czy-all` 仍然跟踪 `origin/czy-all`
- `caozhiyuan/all` 的最新内容已经带进本地 `czy-all`
- `origin/czy-all` 已推送
- PR 已从 `czy-all` 指向 `dev`
- 若有冲突，已逐块分析，而不是整边覆盖

## 一句话目标

这条 skill 的目标不是“把分支硬合上”，而是**把 `dev` 的有效修复与 `czy-all` 的有效增量一块保住，逐个冲突点取两边之长**。
