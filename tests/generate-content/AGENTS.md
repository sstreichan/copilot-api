# Generate Content Test Guide

## Overview

这里集中验证 Gemini 路由：普通 chat-completions 翻译、codex → Responses 分流、流式 tool call 累加、URL operation 路由与错误回退。

## Where To Look

| Task | Location | Notes |
|------|----------|-------|
| Shared setup | `setup.test.ts`, `_test-utils.ts` | `mock.restore()`、request helper、stream builders |
| Route routing | `route-routing.test.ts`, `validation-and-routing.test.ts` | `:generateContent` / `:streamGenerateContent` / `:countTokens` |
| Codex responses | `gemini-codex-responses-*.test.ts` | codex 请求强制走 Responses API |
| Streaming accumulators | `streaming.test.ts`, `stream-tool-call-accumulator.test.ts` | content/tool call 分块与收尾 |
| Translation coverage | `translation*.test.ts`, `core-functionality.test.ts` | Gemini ↔ OpenAI / Responses 转换面 |

## Critical Invariants

- 每个会触发 handler 的测试都要先 mock rate limit；统一走 `createMockRateLimit()`，不要依赖真实 `checkRateLimit()` 状态
- codex 路径测试必须 mock `~/services/copilot/create-responses`，并验证 `capturedResponsesPayload.model === "gpt-5-codex"`；否则分流断言不完整
- streaming Responses mock 事件要维持 `response.created` → `output_item.added` → delta/done → `response.completed` 的顺序，并保持 `sequence_number` 单调递增
- `_test-utils.ts` 里的 helper 默认返回最小可工作的 SSE/chat completion 形状；扩展 helper 时要保持现有测试对 shape 的假设

## Project-Specific Rules

- 目录级 `setup.test.ts` 已在 `afterEach` 里 `mock.restore()`；单个测试不要再遗漏 mock 清理
- 需要 mock `~/server` 时可通过 query string（如 `~/server?route-routing`）绕开模块缓存，保持测试隔离
- `validation-and-routing.test.ts` 里部分错误路径当前固定断言 500；如果改成更精确的 HTTP 状态，要连同文档和相关测试一起更新
- tool call 流式测试用字符串碎片模拟参数累加；不要偷懒改成一次性完整参数，避免失去 accumulator 覆盖

## Anti-Patterns

- 同时 mock chat-completions 与 responses，却不验证究竟走了哪条分支
- 复制大段 stream fixture 到单个测试文件，而不是复用 `_test-utils.ts`
- 省略 query string 导致 `~/server` import 复用旧模块状态
- 只断言响应 status，不检查 `content-type`、SSE `data:` 行或 translated payload 形状
