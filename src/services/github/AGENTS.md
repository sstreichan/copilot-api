# GitHub Service Guide

## Overview

这里是 GitHub / Copilot 认证边界层：只负责向 GitHub 端点发请求、返回原始业务数据或保留原响应的 `HTTPError`，不负责刷新循环与全局状态编排。

## Where To Look

| Task | Location | Notes |
|------|----------|-------|
| Device code start | `get-device-code.ts` | 申请 OAuth device code |
| Device flow polling | `poll-access-token.ts` | 按服务端 interval 轮询 access token |
| Copilot token fetch | `get-copilot-token.ts` | `/copilot_internal/v2/token` |
| Usage / 暗渡门下之输入 | `get-copilot-usage.ts` | 配额查询与 forceAgent 决策 |
| Identity lookup | `get-user.ts` | 登录后打印 `login` |

## Critical Invariants

- 这里是原始 fetch 边界层；刷新循环、token 持久化、telemetry 初始化都在 `~/lib/token.ts`，不要回流到本目录
- `get-copilot-token.ts` 失败时必须抛带原始 status / headers / body 的 `HTTPError`，不能退化成普通 `Error`
- `poll-access-token()` 轮询节奏来自 device code 的 `interval + 1s`；失败时 sleep 后继续，不做指数退避
- `getSmartAgentDecision()` 取数不遂时，返主 `forceAgent: true` 以守配额之限；不可默默当作“预算无恕”

## Project-Specific Rules

- GitHub API 请求头优先走 `githubHeaders(state)`；不要在每个 service 里复制 Authorization 与 editor headers
- `getDeviceCode()` / `pollAccessToken()` 使用 GitHub OAuth device flow 固定端点与 `GITHUB_CLIENT_ID`
- `setupCopilotToken()` 会在 `getCopilotToken()` 成功后立刻调用 `initTelemetry()` 与 `trackAuthNewToken()`；改返回 shape 时别漏 `endpoints.telemetry`
- `getCopilotUsage()` 同时为 usage viewer 与暗渡之门之数据源；改返回接口时须一同检查 `quota_snapshots.premium_interactions`

## Anti-Patterns

- 在本目录里维护 `state.githubToken` / `state.copilotToken` 的并行副本
- 为了省事，丢弃 GitHub 错误响应体，只保留字符串消息
- 修改 OAuth 轮询节奏却不考虑 `deviceCode.interval`
- 把暗渡门下之预算判别塞回 handler 或 route 层，绕开 `get-copilot-usage.ts`
