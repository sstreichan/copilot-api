# Shared Runtime Library Guide

## Overview

`src/lib/` 承载跨路由共享之基础设施：状态、配置、日志、错误、限流、路径、token 生命周期，与暗渡门下之决断，俱从此出。

## Where To Look

| Task | Location | Notes |
|------|----------|-------|
| Runtime singleton state | `state.ts` | 全局唯一真相源；含 interactionId（per-session UUID） |
| Config file / defaults | `config.ts`, `paths.ts` | `COPILOT_API_HOME`、`config.json`、默认 prompts |
| Token lifecycle | `token.ts` | GitHub/Copilot token 获取与刷新；wall-clock 按 token 剩余时间分段重新调度，AbortController 管理生命周期；opencode OAuth 模式复用 GitHub token 并停 refresh loop |
| Rate limit / approval | `rate-limit.ts`, `approval.ts` | `-r` / `-w` 与手动确认 |
| Logging / debug | `logger.ts`, `debug-logger.ts`, `models-log.ts` | stream log、debug dump、models 输出 |
| 暗渡之门策略 | `smart-agent.ts` | forceAgent / 配额决断与缓存 |
| API request config | `api-config.ts` | 统一组装 Copilot headers / host / UA / compact 前处理；含 `prepareForCompact`、`prepareMessageProxyHeaders`、`USER_AGENT`、`COPILOT_VERSION` |
| Compact 标记 | `compact.ts` | compact request / auto-continue prompt 常量、`compactMessageSections` 与 `CompactType` 字面量联合类型 |
| Subagent 标记类型 | `subagent.ts` | `__SUBAGENT_MARKER__` 前缀常量与 `SubagentMarker` 类型；真正解析在 `src/routes/messages/subagent-marker.ts` |

## Project-Specific Conventions

- `state.ts` 不只是方便访问；它是运行时可变状态的唯一位置
- `config.ts` 会把默认 `extraPrompts` 与 `modelReasoningEfforts` 合并回用户配置文件，不只是内存 fallback
- `config.ts` 同时承载 provider 配置：`providers.<name>.baseUrl/apiKey/models.<model>.{temperature,topP,topK}`；取用时统一走 `getProviderConfig()`，不要在路由里手动 trim/校验
- `paths.ts` 支持 `COPILOT_API_HOME` 覆盖默认目录；改路径逻辑时要兼顾 Windows/WSL 使用方式
- `token.ts` 的刷新循环和 telemetry 初始化耦合，改认证链路时别漏 `trackAuthNewToken()` / `initTelemetry()`
- `smart-agent.ts` 只缓存 `forceAgent=true` 之决断；“尚在预算之内”不作缓存之项
- `api-config.ts` 组装请求头后被三个 `create-*` service 共享调用，不要在 service 内重复构造 header
- `logger.ts` 的 `getPremiumInfo()` / `formatStreamLog()` 现在被 chat-completions、messages、responses 三条路由共用；progress log 可以失败，但不能改写 SSE/JSON 响应内容

## Anti-Patterns

- 绕开 `state.ts`，在 handler/service 私自保存运行时副本
- 把配置默认值散落到调用方，而不是统一收口到 `config.ts`
- 在 provider route/service 里直接拼上游 headers 或 response header strip 逻辑，绕过 `getProviderConfig()` / `anthropic-proxy.ts`
- 把 rate limit 的等待实现成隐式重试；项目语义是 sleep，不是 retry/backoff
- 修改路径规则却不考虑 `COPILOT_API_HOME` 和本地数据目录兼容性
