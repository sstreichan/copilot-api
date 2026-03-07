# Copilot Service Boundary Guide

## Overview

这个目录是真正触达上游 Copilot / GitHub backend 的边界层；这里处理 headers、telemetry、signature retry、native messages 适配与 model metadata。

## Where To Look

| Task | Location | Notes |
|------|----------|-------|
| Chat Completions upstream | `create-chat-completions.ts` | OpenAI-compatible 主调用器 |
| Native messages upstream | `create-messages.ts` | Vertex AI / native messages 适配集中地 |
| Responses upstream | `create-responses.ts` | Copilot Responses API |
| Models metadata | `get-models.ts` | capability / limits / supported_endpoints |
| Embeddings | `create-embeddings.ts` | OpenAI-compatible embeddings |

## Project-Specific Conventions

- `create-messages.ts` 是 backend workaround 收口点：`reorderAssistantBlocks`、`stripThinkingBlocks`、`anthropic-beta` allowlist、adaptive thinking、vision header 都放这里
- `X-Initiator` 由显式 options 与 smart-agent 决策共同决定；不要跳过 `resolveInitiatorWithSmartAgent()`
- telemetry 发送、成功/失败打点、feedback scheduling 在 service 层做，不回推到 route handler
- `create-messages.ts` 会在 thinking 签名错误时做一次 strip-thinking retry；项目里没有通用 retry/backoff 框架

## Native Messages Gotchas

- 只能移动 `text` / `tool_use` 的相对顺序；`thinking` / `redacted_thinking` 必须保留原位
- adaptive thinking 用 capability 检测，不用硬编码模型名
- 显式传入的 `anthropic-beta` 不是全量透传，而是 allowlist 过滤后再发给后端

## Anti-Patterns

- 在 handler、translation 或测试 helper 里复制 backend workaround
- 重新引入通用重试掩盖真实上游错误
- 修改 thinking block 顺序或内容再发给 Vertex AI
- 直接 hardcode model → effort / capability 映射而不走现有 metadata/config 逻辑
