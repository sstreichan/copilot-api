<!-- OPENSPEC:START -->

# OpenSpec Instructions

These instructions are for AI assistants working in this project.

Always open `@/openspec/AGENTS.md` when the request:

- Mentions planning or proposals (words like proposal, spec, change, plan)
- Introduces new capabilities, breaking changes, architecture shifts, or big performance/security work
- Sounds ambiguous and you need the authoritative spec before coding

Use `@/openspec/AGENTS.md` to learn:

- How to create and apply change proposals
- Spec format and conventions
- Project structure and guidelines

Keep this managed block so 'openspec update' can refresh the instructions.

<!-- OPENSPEC:END -->

# copilot-api AGENTS

GitHub Copilot API 反向代理，基于 **Hono**，对外暴露 OpenAI / Anthropic / Gemini 兼容端点。

## 全局规则

- 不要猜测；不确定时先验证，无法验证就明确说明。
- 默认中文回复。
- 收到明确任务或 skill 指令时直接执行；只有确实缺少关键上下文时才提问。
- 运行时代码优先查看 `src/`；测试优先查看 `tests/`；多实例调遣之器（Sticky Router）藏于 `router/`；提案流程查看 `openspec/`。
- `.vendor/`、`.sisyphus/`、`.debates/`、`history/`、`experiments/` 默认不是主运行时逻辑，除非任务明确涉及。

## 快速参考

```bash
bun run dev            # 开发服务器（watch）
bun test               # 全量测试
bun run lint:all --fix # Lint 并修复
bun run typecheck      # 类型检查
```

常用启动标志：

- `-M`：Claude 模型走原生 `/v1/messages`
- `-F`：启用暗渡之门（按配额转圜流向，详情参见 `src/lib/smart-agent.ts`）
- `-a business`：指定账户类型
- `--manual`：手动审批每个请求
- `--proxy-env`：从环境变量读取代理配置

## 架构总览

- 主链路：`客户端兼容 API → OpenAI 中间格式（多数模型）→ GitHub Copilot API`
- 例外：`-M` 时，Claude 模型绕过中间格式，直接走 Copilot 原生 `/v1/messages`；该分支上游校验更严格。
- 路由通常双注册在 `/` 与 `/v1/`；新增公开端点时，先检查是否需要双前缀同时挂载。
- 共享运行时状态的唯一真相源是 `src/lib/state.ts`；不要复制平行状态缓存。
- 后端兼容补丁放 `src/services/copilot/*`；`handler.ts` 负责路由分发与翻译编排，不承载上游 workaround。

## 必须记住的跨目录约束

- 所有流式翻译都必须保证 `stream.close()` 能在清理路径中执行，通常通过 `try/finally` 保证。
- `finish_reason: "tool_calls"` 是中间态，不是终态；不要在这里清空工具调用累加器。
- 使用 `~` 别名导入 `src/` 下模块。
- 默认使用 `consola` 或项目 logger helper；不要新增 `console.log` 风格日志。
- 调试 Copilot 后端时，使用 `copilot-backend-tester` skill，并带 `X-Initiator: agent`。

## 目录导航

- `src/AGENTS.md` - 运行时代码总览：CLI、server、routes、services、shared state
- `src/lib/AGENTS.md` - `state.ts`、`config.ts`、`token.ts`、`smart-agent.ts` 等共享基础设施约束
- `src/routes/messages/AGENTS.md` - Anthropic `/v1/messages`、native messages、streaming 约束
- `src/routes/chat-completions/AGENTS.md` - OpenAI chat completions 路由与 stream/non-stream 分支
- `src/routes/models/AGENTS.md` - `/v1/models` 过滤、排序与增强字段
- `src/routes/responses/AGENTS.md` - OpenAI Responses 路由、stream ID sync、tool 预处理
- `src/routes/generate-content/AGENTS.md` - Gemini 路由与 codex/responses 分流
- `src/routes/provider/AGENTS.md` - `/:provider/v1/*` 代理路由、messages/models/count_tokens 分流
- `src/services/AGENTS.md` - service 根层边界与目录职责
- `src/services/copilot/AGENTS.md` - Copilot 上游调用、native messages 兼容、telemetry
- `src/services/github/AGENTS.md` - GitHub auth、device flow、Copilot token、usage
- `src/services/providers/AGENTS.md` - 多 provider 转发、header allowlist、response 清洗
- `src/services/telemetry/AGENTS.md` - telemetry envelope、identity、fire-and-forget
- `tests/AGENTS.md` - Bun 测试布局、mock 约定、fixtures、断言风格
- `tests/generate-content/AGENTS.md` - Gemini / codex 测试约束
- `tests/router/AGENTS.md` - 多实例调遣之器测试规约：fetch/time 注入与 sticky 之验证
- `router/AGENTS.md` - 多实例调遣之器之内里：session-sticky、least-loaded、dashboard、start.sh
- `claude-plugin/AGENTS.md` - Claude Code plugin / marketplace 与 `__SUBAGENT_MARKER__`
- `openspec/AGENTS.md` - proposal、delta spec、validate / archive 工作流

## 任务入口建议

- 改 CLI 启动、flags、middleware、全局配置：先看 `src/AGENTS.md`
- 改 Claude / Messages / thinking / tool calling：先看 `src/routes/messages/AGENTS.md` 与 `src/services/copilot/AGENTS.md`
- 改 OpenAI chat / responses / models 兼容层：先看对应 `src/routes/*/AGENTS.md`
- 改多实例调遣或 dashboard：先看 `router/AGENTS.md`
- 改测试或补回归：先看 `tests/AGENTS.md`
- 做 proposal / spec / architecture 级变更：先看 `openspec/AGENTS.md`

## 任务追踪

本项目使用 **bd (beads)** 跟踪工作；不要在仓库根目录维护 markdown TODO 作为主追踪方式。

```bash
bd ready --json
bd create "标题" -t bug|feature|task -p 0-4 --json
bd update bd-42 --status in_progress --json
bd close bd-42 --reason "完成" --json
```

## 近期高价值变更提示

- Claude `-M` 原生 messages 分支别有上游约束；相关兼容逻辑集中在 `src/services/copilot/create-messages.ts`。
- 暗渡之门（`-F`）之取舍，并 token / usage 判别之机，俱归 `src/lib/smart-agent.ts` 与相关 usage service 收束。
- Provider-scoped 路由、Responses API、`/v1/models` 增强能力都已有现成实现；改动前先读对应目录 AGENTS。
- 最近 1 个 commit 把上游 quota / rate-limit headers 的处理收束为跨目录契约：`src/services/copilot/*` 负责附着原始 headers，`src/lib/response-headers.ts` 统一过滤/转发，`src/routes/*` 负责最终回包，`router/` 则把 snapshot 暴露到 `/api/status` 与 dashboard。
