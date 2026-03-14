# Responses Route Guide

## Overview

这里是 OpenAI-compatible `/v1/responses` 路由层：负责请求预处理、agent/vision 推断，以及为下游 SDK 修正 Copilot 原生 Responses stream 的事件细节。

## Where To Look

| Task | Location | Notes |
|------|----------|-------|
| Route entry | `route.ts`, `handler.ts` | stream / non-stream 共用 `handleResponses()` |
| Stream ID sync | `stream-id-sync.ts` | 修正 added/done 事件 ID 不一致 |
| Vision / initiator detection | `utils.ts` | 只看 `payload.input` 与最后一项 role |
| Payload preflight | `handler.ts` | `apply_patch` function 化、`web_search` 过滤、端点支持校验 |

## Critical Invariants

- `useFunctionApplyPatch()` 必须早于 `removeWebSearchTool()` 与模型端点支持检查；否则错误路径和上游工具集会失真
- 流式 Responses 事件在写回 SSE 前，必须经过 `createStreamIdTracker()` + `fixStreamIds()`；这是 `@ai-sdk/openai` 兼容补丁，不可跳过
- `hasAgentInitiator()` 只检查最后一个 input item；历史里出现过 assistant 不能把当前用户请求误记为 agent
- `handleResponses()` 同时承担 stream / non-stream 两条路径；不要拆成第二套 handler 逻辑

## Project-Specific Rules

- `apply_patch` custom tool 会被改写成单一 `input: string` 的 function tool；改 schema 时要同步依赖这个形状的客户端
- `web_search` tool 在这里被无条件移除，因为 Copilot Responses 后端不支持它
- 当模型不支持 `/responses` 时，直接返回 400 `invalid_request_error`；不要把这个失败拖到上游 fetch
- `stream-id-sync.ts` 会在 `response.output_item.added` 缺少 `item.id` 时补造 `oi_*` ID；后续事件必须复用该映射

## Anti-Patterns

- 直接透传 Copilot 原始 Responses stream，忘记做 ID 同步
- 在别的路由里复制 `apply_patch` / `web_search` 预处理，造成规则分叉
- 通过扫描整段历史推断 agent/user，而不是看最后一个 input item
- 把 Responses 路由的流式收尾逻辑外包给调用者，丢掉本地 `finally`
