# Gemini Route Guide

## Overview

这里负责 Gemini-compatible API：既要把 Gemini payload 翻译到 OpenAI chat completions，也要对 codex 类模型切到 Copilot Responses API。

## Where To Look

| Task | Location | Notes |
|------|----------|-------|
| Route entry | `route.ts`, `handler.ts` | model 从 URL 提取，stream / non-stream 共用主 handler |
| Gemini ↔ OpenAI | `translation.ts` | 常规 Gemini 转换 |
| Gemini ↔ Responses | `responses-translation.ts`, `responses-stream-translation.ts` | codex / responses 分支 |
| Shared type contracts | `types.ts` | Gemini request/response 类型 |
| Helper utilities | `utils.ts` | 路由辅助逻辑 |

## Critical Invariants

- `shouldUseResponsesApi()` 当前按模型名中的 `codex` 判定；改分流规则时要同步测试与 Gemini responses 翻译器
- `stream=true` 和 `stream=false` 共用 `handleGeminiGeneration()`；不要分叉出第二套业务逻辑
- 非流式结果转换成流式时，必须在 `finally` 里显式 `stream.close()`
- vision / initiator 会在 Responses 分支从 Gemini contents 推断；不要丢掉 `inlineData` 与 `model` role 检测

## Project-Specific Rules

- `DEBUG_GEMINI_REQUESTS=true` 时，handler 会异步落请求/响应调试日志
- codex 模型走 Responses API，其它 Gemini 模型仍走 chat completions；这和 Anthropic route 的分流规则不同
- count-tokens 路径依赖 Gemini → OpenAI 映射后的模型名，再去 `state.models` 里找限制与 tokenizer 信息

## Anti-Patterns

- 同时在 `translation.ts` 和 `responses-translation.ts` 里维护一套重复映射表
- 把流式结束清理留给上层调用者，忘记本地 `finally`
- 修改 model URL 解析逻辑却不回归 `:generateContent` / `:streamGenerateContent` / `:countTokens` 相关测试
