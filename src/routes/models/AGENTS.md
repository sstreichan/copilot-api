# Models Route Guide

## Overview

这里封装增强版 `/v1/models`：从 `state.models` 取上游模型清单，过滤不可选模型，补齐 limits / capability / billing 字段，并按本项目约定排序后返回。

## Where To Look

| Task | Location | Notes |
|------|----------|-------|
| Route entry | `route.ts` | 仅有 `GET /`，失败统一走 `forwardError()` |
| Limit shaping | `route.ts` | `buildLimits()` 负责 thinking_budget / vision 展开 |
| Sort policy | `route.ts` | `sortModels()` 先类型，再 premium，再 token 容量 |
| Fallback cache | `route.ts` | `state.models` 为空时补跑 `cacheModels()` |

## Critical Invariants

- `state.models` 为空时，必须先 `await cacheModels()`；不要假定启动阶段永远已缓存好模型
- `.filter((m) => m.model_picker_enabled)` 是对外暴露前的硬过滤；不要把未启用模型漏给客户端
- `buildLimits()` 要对 `caps.limits ?? {}` 做防御性处理；某些模型（特别是 embeddings）在运行时可能没有完整 limits
- 返回顺序由 `sortModels()` 固定：`chat` 优先于 `completion` / `embeddings`，同类型内 premium 优先，再按 `max_prompt` / `context_window` 降序

## Project-Specific Rules

- `limits.thinking_budget` 只在同时存在 `min_thinking_budget` 与 `max_thinking_budget` 时暴露
- `limits.vision` 只在 `rawLimits.vision` 存在时展开，且要把 image size / image count / media types 一并映射出来
- 返回体同时保留 backward-compatible 字段（`id/object/type/created/created_at/owned_by`）和本项目增强字段（`family/preview/endpoints/supports_*`）
- `created` / `created_at` 目前没有上游真实时间，固定为 `0` / `new Date(0).toISOString()`；不要伪造发布日期

## Anti-Patterns

- 直接把上游 `state.models.data` 原样返回，跳过本地过滤与排序
- 只按模型名排序，丢掉 premium 与 token 容量优先级
- 对缺失 limits 的模型直接取深层字段，触发运行时异常
- 在别的路由里复制 models 变形逻辑，而不是统一走这里的 `/v1/models`
