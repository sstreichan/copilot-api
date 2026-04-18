# Provider Service Guide

## Overview

这里是多 provider 上游转发边界。目前只支持 `anthropic` 类型 provider，把本地请求安全转发到外部 Anthropic-compatible 服务。

## Where To Look

| Task | Location | Notes |
|------|----------|-------|
| Header shaping | `anthropic-proxy.ts` | `buildProviderUpstreamHeaders()` |
| Response passthrough | `anthropic-proxy.ts` | `createProviderProxyResponse()` |
| Messages forwarding | `anthropic-proxy.ts` | `forwardProviderMessages()` |
| Models forwarding | `anthropic-proxy.ts` | `forwardProviderModels()` |

## Critical Invariants

- 上游认证固定走 `x-api-key: providerConfig.apiKey`；不要把 Copilot/GitHub token 混入 provider 请求
- 只有 `anthropic-version`、`anthropic-beta`、`accept`、`user-agent` 四类头会从客户端继续透传；其余 header 默认丢弃
- `createProviderProxyResponse()` 必须删除 hop-by-hop response headers（`content-length`、`transfer-encoding` 等）后再回给客户端
- `forwardProviderMessages()` 只 POST 到 `${baseUrl}/v1/messages`，`forwardProviderModels()` 只 GET `${baseUrl}/v1/models`；不要在 service 层猜测额外端点

## Project-Specific Rules

- `getProviderConfig()` 已负责 baseUrl trim、apiKey trim、enabled/type 校验；service 层假定拿到的是合法 `ResolvedProviderConfig`
- provider service 不参与 telemetry、暗渡之门、interaction headers；这些仅属于 Copilot service 边界

## Anti-Patterns

- 原样透传上游 response headers，导致 hop-by-hop 头污染 Hono 响应
- 在多个 provider service 文件里复制 allowlist/strip 列表，造成规则分叉
- 为 provider 请求补 Copilot 专属 headers（`x-request-id`、`x-interaction-id`、`openai-intent`）
