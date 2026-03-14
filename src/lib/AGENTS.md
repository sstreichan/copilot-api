# Shared Runtime Library Guide

## Overview

`src/lib/` 承载跨路由共享的基础设施：状态、配置、日志、错误、限流、路径、token 生命周期和 smart-agent 决策都从这里出发。

## Where To Look

| Task | Location | Notes |
|------|----------|-------|
| Runtime singleton state | `state.ts` | 全局唯一真相源；含 interactionId（per-session UUID） |
| Config file / defaults | `config.ts`, `paths.ts` | `COPILOT_API_HOME`、`config.json`、默认 prompts |
| Token lifecycle | `token.ts` | GitHub/Copilot token 获取与刷新循环；AbortController 管理生命周期 |
| Rate limit / approval | `rate-limit.ts`, `approval.ts` | `-r` / `-w` 与手动确认 |
| Logging / debug | `logger.ts`, `debug-logger.ts`, `models-log.ts` | stream log、debug dump、models 输出 |
| Smart agent policy | `smart-agent.ts` | forceAgent / quota 决策与缓存 |
| API request config | `api-config.ts` | Copilot headers 组装（interaction、intent、request ID） |

## Project-Specific Conventions

- `state.ts` 不只是方便访问；它是运行时可变状态的唯一位置
- `config.ts` 会把默认 `extraPrompts` 与 `modelReasoningEfforts` 合并回用户配置文件，不只是内存 fallback
- `paths.ts` 支持 `COPILOT_API_HOME` 覆盖默认目录；改路径逻辑时要兼顾 Windows/WSL 使用方式
- `token.ts` 的刷新循环和 telemetry 初始化耦合，改认证链路时别漏 `trackAuthNewToken()` / `initTelemetry()`
- `smart-agent.ts` 只缓存 `forceAgent=true` 的决策；“还在预算内”不是缓存项
- `api-config.ts` 组装请求头后被三个 `create-*` service 共享调用，不要在 service 内重复构造 header

## Anti-Patterns

- 绕开 `state.ts`，在 handler/service 私自保存运行时副本
- 把配置默认值散落到调用方，而不是统一收口到 `config.ts`
- 把 rate limit 的等待实现成隐式重试；项目语义是 sleep，不是 retry/backoff
- 修改路径规则却不考虑 `COPILOT_API_HOME` 和本地数据目录兼容性
