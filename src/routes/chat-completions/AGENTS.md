# Chat Completions Route Guide

## Overview

这里承载 OpenAI-compatible `/v1/chat/completions` 路由：负责请求前置处理（限流、manual approve、`max_tokens` 默认补全）并调用 Copilot chat-completions service。

## Where To Look

| Task | Location | Notes |
|------|----------|-------|
| Route entry | `route.ts` | `POST /`，异常统一 `forwardError()` |
| Main handler | `handler.ts` | 限流、manual approve、`max_tokens` 默认值、stream/non-stream 分支 |
| Upstream call | `~/services/copilot/create-chat-completions.ts` | `x-initiator` 决策、thinking 签名重试、telemetry |

## Critical Invariants

- `handler.ts` 必须先执行 `checkRateLimit(state)`；不要把限流下沉到 response 之后。
- `state.manualApprove` 打开时，必须在请求发往上游前 `await awaitApproval()`。
- 当 `payload.max_tokens` 缺失时，按 `state.models` 中所选模型的 `capabilities.limits.max_output_tokens` 回填；不要硬编码默认值。
- `requestId` 必须由 `generateRequestIdFromPayload()` 生成并下传到 service，`sessionId` 由 `getUUID(requestId)` 派生，保持 telemetry/日志关联稳定。
- 流式分支必须走 `streamSSE()`，并在循环结束后写入 stream log；不要丢失 `[DONE]` 事件。
- 非流式分支返回 JSON 前必须附带 premium 信息统计日志，保证与流式路径一致可观测。
- chat-completions 若从 service 拿到 attached upstream headers，则 non-stream 走 `jsonWithForwardedHeaders()`，stream 先 `applyForwardableResponseHeaders()` 再 `streamSSE()`；不要在 handler 里重拼 quota/rate-limit headers

## Project-Specific Rules

- `chat-completions` 路径目前不处理 subagent marker（`handler.ts` 注释已声明）；不要在这里引入 messages 路径的 marker 合并逻辑。
- `create-chat-completions.ts` 会据末条 message role 推导 `x-initiator`（assistant/tool → agent，余者 → user），并与暗渡门下之决断合流；不要在 route 层重复判断。
- 上游 400 若命中 thinking/signature 错误，会触发“strip reasoning fields 后重试”分支（`reasoning_opaque` + `reasoning_text`）；route 层不要复制这套重试。
- vision 请求依赖 service 侧自动检测 image content 并设置 header，route 层不做额外 header 拼接。

## Anti-Patterns

- 在 route 层复制 `isThinkingBlockError` 与 retry 逻辑，绕过 service 边界。
- 直接返回上游流而不经 `streamSSE`，导致日志与结束语义不一致。
- 手动构造 `x-request-id` 或 `x-initiator` 覆盖 service 计算结果。
- 让 stream 和 non-stream 分支分别维护两套 header 透传规则，造成 quota/rate-limit 头不一致
