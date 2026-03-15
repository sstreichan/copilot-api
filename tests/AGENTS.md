# Test Suite Guide

## Overview

测试统一使用 `bun:test`，覆盖路由翻译、native messages、telemetry、models、smart agent 和 Gemini/Responses 分支；主策略是 mock 上游服务，而不是打真实 Copilot API。

## Structure

- `create-messages.test.ts`, `create-chat-completions.test.ts`, `create-responses.test.ts` - service 边界测试
- `native-messages-handler.test.ts`, `anthropic-*.test.ts`, `responses-*.test.ts` - Anthropic / Responses 路径
- `generate-content/` - Gemini 路由、translation、streaming、codex/responses 分支；详见 `tests/generate-content/AGENTS.md`
- `router/` - Sticky router 单元测试（lib.test.ts, state.test.ts, proxy.test.ts, integration.test.ts）；注入 `fetchImpl`/`now` 参数 mock
- `router/` 有独立测试约定；详见 `tests/router/AGENTS.md`
- `telemetry*.test.ts` - telemetry 与 identity
- `fixtures/` - 录制数据；优先复用，不要请求真实 API

## Project-Specific Conventions

- 统一用 `mock.module(...)` 替换 `~/services/...`、`~/lib/...` 依赖
- service / route 行为变更时，测试应对齐真实契约；如果契约属于文档化能力，通常还要同步 OpenSpec
- 不要硬编码 token 计数；用 `expect.any(Number)` 或对行为做区间/结构断言
- `state` 是共享单例，测试要在 `beforeEach` 里重置相关字段与缓存（例如 smart agent cache）
- telemetry 30% 采样相关断言必须 mock `Math.random()` 或改为结构断言；不要把随机门限当成稳定输出

## Commands

```bash
bun test
bun test tests/create-messages.test.ts
```

## Anti-Patterns

- 真实调用 Copilot / GitHub API
- 为了让测试通过而删除已有失败断言
- 复制大型 fixture 内容进测试文件；优先放 `tests/fixtures/`
- 忘记恢复全局状态、fetch mock 或 smart agent cache
- 在 router 测试里断言随机 tie-break 的具体端口号；对 least-loaded 平局必须用集合/相等性断言 sticky 语义
