# OpenSpec 工作流指南

## Overview

`openspec/` 管理提案驱动的架构变更流程：proposal → design → spec → tasks → archive。非运行时代码。

## Structure

- `project.md` - 项目上下文：目的、技术栈、约定、领域知识
- `specs/` - 持久规格文档（跨 change 共享）
- `changes/` - 活跃变更提案目录
- `changes/archive/` - 已归档的变更（含 proposal、design、spec、tasks）

## Where To Look

| Task | Location | Notes |
|------|----------|-------|
| 项目上下文 | `project.md` | 技术栈、约定、领域术语 |
| 持久规格 | `specs/*/spec.md` | router-load-balancing、auto-session-manager |
| 活跃变更 | `changes/*/proposal.md` | 当前进行中的提案 |
| 归档变更 | `changes/archive/*/` | 含完整 proposal → design → spec → tasks |

## Conventions

- 变更流程：`/opsx-propose`（创建提案）→ `/opsx-apply-change`（实施任务）→ `/opsx-archive-change`（归档）
- `project.md` 是全局上下文，所有变更共享；不要在 proposal 里重复 project.md 已有信息
- `specs/` 存放跨变更复用的规格定义；单个变更的 spec 放在变更目录内
- 归档后的变更目录结构与活跃变更一致，只是移入 `archive/` 子目录并标注完成状态

## Anti-Patterns

- 在 `openspec/` 里放运行时代码或测试
- 修改归档变更的内容（归档 = 只读）
- 在 proposal 里重复 `project.md` 已有的技术栈/约定信息