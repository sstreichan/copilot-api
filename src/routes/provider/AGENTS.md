# Provider Route Guide

## Overview

这里承载 provider-scoped Anthropic 兼容路由：把 `/:provider/v1/messages` 与 `/:provider/v1/models` 转发到配置里的上游 Anthropic 兼容服务，并保留本地的错误包装与日志。

## Structure

- `messages/route.ts` - `POST /` 与 `POST /count_tokens`
- `messages/handler.ts` - payload 注入 per-model temperature/topP/topK，stream / non-stream 分流
- `models/route.ts` - `GET /` 上游 models 透传

## Where To Look

| Task | Location | Notes |
|------|----------|-------|
| Provider messages proxy | `messages/handler.ts` | 读取 provider config、转发 `/v1/messages` |
| Provider token counting | `messages/count-tokens-handler.ts` | Anthropic → OpenAI 转换后本地 tokenizer 计算 |
| Provider models proxy | `models/route.ts` | 透传 `/v1/models`，保留上游 status/header |
| Upstream fetch boundary | `~/services/providers/anthropic-proxy.ts` | header allowlist、response header strip |

## Critical Invariants

- 只有 `getProviderConfig(provider)` 返回非 null 时才允许进入上游；缺 provider 或 disabled provider 直接 404 `invalid_request_error`
- `messages/handler.ts` 只为 payload 注入 provider config 里的 `temperature` / `top_p` / `top_k` 默认值；显式请求值优先，不要覆盖已给定参数
- Provider streaming 只在 `payload.stream === true` 且上游 `content-type` 包含 `text/event-stream` 时走 `streamSSE()`；其它情况统一走 `createProviderProxyResponse()`
- `messages/count_tokens` 不访问 provider 上游；它复用 `translateToOpenAI()` + 本地 tokenizer，找不到模型时允许用 provider fallback model

## Project-Specific Rules

- provider-scoped 端点只注册 `/:provider/v1/messages` 和 `/:provider/v1/models`；不要再为 provider 分支额外挂 `/messages` 无前缀别名
- `provider/messages/handler.ts` 会把请求头原样传给 service 层筛选；真正可转发 header allowlist 只在 `services/providers/anthropic-proxy.ts` 维护
- provider token counting 的 fallback model 必须 `model_picker_enabled: false`、`vendor: "provider"`，避免把临时模型漏进 `/v1/models`

## Anti-Patterns

- 在 route 层拼 `x-api-key` / `anthropic-beta` / `user-agent`，绕开 provider service 的统一 header 处理
- 把 provider 路由混入 Copilot native messages / Responses 之特例逻辑；此处纯为 provider proxy，不与暗渡之门 / telemetry 同谭
- provider `count_tokens` 失败时抛 500；当前约定是保守返回 `{ input_tokens: 1 }`
