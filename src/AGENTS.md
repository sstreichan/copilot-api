# Runtime Code Guide

## Overview

`src/` 是运行时代码主干：CLI 入口、Hono server、路由翻译层、Copilot 上游调用、共享状态与配置都在这里。

## Structure

- `main.ts` - CLI 根入口，挂 `auth` / `start` / `check-usage` / `debug`
- `start.ts` - `citty` 命令定义、启动流程、usage viewer 链接、CLI flags
- `server.ts` - Hono 中间件与路由注册；注意 `/` 与 `/v1/` 双注册模式
- `lib/` - 共享状态、配置、日志、限流、paths、proxy、tokenizer 等
- `routes/` - 各兼容 API 的 handler / translation / stream translation
- `services/` - 真正访问 Copilot / GitHub / telemetry 的边界层

## Nested Guides

- `lib/AGENTS.md` - `state.ts`、`config.ts`、`token.ts`、`smart-agent.ts` 的共享基础设施约束
- `routes/messages/AGENTS.md` - Anthropic messages / native messages 分支细节
- `routes/chat-completions/AGENTS.md` - OpenAI chat completions 路由约束、stream/non-stream 分支与 service 边界
- `routes/models/AGENTS.md` - `/v1/models` 过滤、排序与增强字段映射规则
- `routes/responses/AGENTS.md` - OpenAI Responses 路由、stream ID sync 与 tool 预处理约束
- `routes/generate-content/AGENTS.md` - Gemini 路由与 codex/responses 分流
- `routes/provider/AGENTS.md` - Provider-scoped Anthropic 代理路由、messages/models/count_tokens 分流
- `services/AGENTS.md` - service 根层边界与子目录职责分工（copilot/github/providers/telemetry）
- `services/copilot/AGENTS.md` - 上游 Copilot 请求、retry、telemetry、backend workaround
- `services/github/AGENTS.md` - GitHub auth/device flow、Copilot token 与 usage 获取边界
- `services/providers/AGENTS.md` - 多 provider 转发、header allowlist、response 透传规则
- `services/telemetry/AGENTS.md` - telemetry envelope、identity 与 fire-and-forget 发送规则

## Where To Look

| Task | Location | Notes |
|------|----------|-------|
| CLI flags / startup | `start.ts`, `main.ts` | `-M`、`-F`、`--proxy-env`、Claude Code env script |
| Global middleware / route mount | `server.ts` | messages logger 例外、CORS、auth、双前缀注册 |
| Shared runtime state | `lib/state.ts` | 唯一真相源；不要复制缓存 |
| Config defaults / prompts | `lib/config.ts` | `extraPrompts`、`smallModel`、`modelReasoningEfforts` |
| Token / auth lifecycle | `lib/token.ts`, `services/github/*` | 刷新循环、GitHub token、Copilot token |
| Provider proxy / multi-provider | `routes/provider/*`, `services/providers/*`, `lib/config.ts` | `/:provider/v1/*`、per-model temperature/topP/topK、x-api-key 透传 |
| Endpoint-specific behavior | `routes/*`, `services/copilot/*` | 路由负责分发与翻译，service 负责上游调用 |
| API request headers | `lib/api-config.ts` | Interaction headers、intent、request ID 组装 |

## Project-Specific Conventions

- 导入 `src/` 下模块时使用 `~` 别名，不要退回长相对路径
- 新增 OpenAI-compatible 路由时，通常要同时注册 `/foo` 和 `/v1/foo`
- `handler.ts` 做分支与格式编排；Copilot 后端 workaround 放在 `services/copilot/*`
- provider-scoped 路由只暴露 `/:provider/v1/messages`、`/:provider/v1/models`；messages count_tokens 在 provider messages 子路由内部处理，不额外挂 `/v1` 兼容别名
- 全局可变状态只放 `lib/state.ts`
- 日志统一用 `consola` 或项目 logger helper，不用 `console.log`

## Anti-Patterns

- 在多个模块维护平行状态缓存
- 在 handler 里堆积后端兼容补丁，绕过 `services/copilot/*`
- 只改 `/v1/...` 或只改无前缀路由，忘记另一侧注册
- 忽略 `stream.close()` / `finally` 清理路径
