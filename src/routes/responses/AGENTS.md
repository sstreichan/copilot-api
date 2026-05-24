# Responses Route Guide

## Overview

这里是 OpenAI-compatible `/v1/responses` 路由层：负责请求预处理、agent/vision 推断，以及为下游 SDK 修正 Copilot 原生 Responses stream 的事件细节。

## Where To Look

| Task | Location | Notes |
|------|----------|-------|
| Route entry | `route.ts`, `handler.ts` | stream / non-stream 共用 `handleResponses()` |
| Stream ID sync | `stream-id-sync.ts` | 修正 added/done 事件 ID 不一致 |
| Vision / initiator detection | `utils.ts` | 只看 `payload.input` 与最后一项 role |
| Payload preflight | `preflight.ts` | 4-step mutation: `removeUnsupportedTools` → `removeWebSearchTool`（条件）→ input normalize → compact |
| Input normalization | `utils.ts` (`normalizeResponsesInputForReplay`) | 把 replay input 整理成上游可接受形态 |
| Compact input collapse | `utils.ts` (`compactInputByLatestCompaction`) | 仅保留最近一次 compaction 之后的 input 项 |
| Messages backend fallback | `responses-from-messages.ts` | Anthropic Messages ↔ Responses 双向翻译，含 monotonic `sequence_number` 与 assistant 合并 |
| Chat completions fallback | `responses-from-chat.ts` | Chat Completions ↔ Responses 双向翻译，含 stream event 序列号 |

## Critical Invariants

- 流式 Responses 事件在写回 SSE 前，必须经过 `createStreamIdTracker()` + `fixStreamIds()`；这是 `@ai-sdk/openai` 兼容补丁，不可跳过
- `hasAgentInitiator()` 只检查最后一个 input item；历史里出现过 assistant 不能把当前用户请求误记为 agent
- `handleResponses()` 同时承担 stream / non-stream 两条路径；不要拆成第二套 handler 逻辑
- Responses 路由若拿到 attached upstream headers，则 non-stream 用 `jsonWithForwardedHeaders()`，stream 在开始写事件前先过滤并应用可转发 headers；不能只修 body 不修外层响应头

## Project-Specific Rules

- `apply_patch` custom tool 按上游策略保持 custom 形态；不要在 handler 里复制预处理逻辑重新改写它
- `web_search` tool 是否移除由 `useResponsesApiWebSearch` 配置决定；关闭时才在这里剥离
- 当模型不支持 `/responses` 时，直接返回 400 `invalid_request_error`；不要把这个失败拖到上游 fetch
- `stream-id-sync.ts` 会在 `response.output_item.added` 缺少 `item.id` 时补造 `oi_*` ID；后续事件必须复用该映射
- `responses-from-messages.ts` 的 stream 翻译现在必须输出 monotonic `sequence_number` 和完整的 `response.output_item.added/done` 生命周期；assistant text + tool_use 合并为同一 message（防止 Claude replay 断流）
- `preflight.ts` 独立管理 payload mutation pipeline；`handler.ts` 调用它但不直接操作 payload
- `prompt_cache_key` 缺失时由 `stableSessionKey` 注入；`normalizeResponsesInputForReplay()` 与 `compactInputByLatestCompaction()` 必须在 stream id sync 之前完成
- `compactInputByLatestCompaction()` 在 messages → responses 路径（`api-flows.ts`）也复用；改语义时两处一并验
- stream/non-stream 两条路径都要保留上游 quota/rate-limit headers；缺口通常先查 route helper 调用，再查 service 是否附着了 headers

## Anti-Patterns

- 直接透传 Copilot 原始 Responses stream，忘记做 ID 同步
- 在别的路由里复制 `web_search` 预处理，造成规则分叉
- 通过扫描整段历史推断 agent/user，而不是看最后一个 input item
- 把 Responses 路由的流式收尾逻辑外包给调用者，丢掉本地 `finally`
- 只在 non-stream 分支转发 upstream headers，遗漏 stream 分支的 quota/rate-limit 可观测性
