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

## 基本规则

- 不要猜测或臆断。不确定时用搜索工具验证，无法验证就明确说明。
- 收到 skill 或明确任务指令时立即执行，除非关键信息确实缺失，否则不要问澄清问题。
- 不要声称自己是特定模型，除非已验证。
- 默认给出详尽、全面的回答。
- 有多个搜索/MCP 工具时，全部使用，跨源对比结果。
- 语言策略：默认中文回复。

## 项目概述

GitHub Copilot API 的反向代理，基于 **Hono** 框架（非 Express），暴露 OpenAI/Anthropic/Gemini 兼容端点。使用**三层架构**做格式转换：

```
客户端 API (Anthropic/Gemini/OpenAI) → OpenAI 格式 → GitHub Copilot API
```

**例外**：使用 `-M` 标志时，Claude 模型绕过转换，直接使用 Copilot 的原生 `/v1/messages` 端点。请求走 **Vertex AI** 后端（非 Anthropic 原生 API），验证规则更严格。

## 分层 AGENTS 导航

- `src/AGENTS.md` - 运行时代码总览；路由、服务、共享状态、配置入口
- `src/lib/AGENTS.md` - 共享状态、配置、token 生命周期、smart agent、路径与日志约束
- `src/routes/messages/AGENTS.md` - Anthropic `/v1/messages` 分支顺序、流式不变量、native messages 限制
- `src/routes/chat-completions/AGENTS.md` - OpenAI chat completions 路由约束、stream/non-stream 分支与上游 service 边界
- `src/routes/models/AGENTS.md` - 增强版 `/v1/models`，过滤、排序与 limits/capability 映射规则
- `src/routes/responses/AGENTS.md` - OpenAI Responses 路由、stream ID 同步、tool 预处理规则
- `src/routes/generate-content/AGENTS.md` - Gemini 路由分流、Responses/codex 分支、流式关闭要求
- `src/routes/provider/AGENTS.md` - Provider-scoped Anthropic 代理路由、count_tokens 回退与上游透传规则
- `src/services/AGENTS.md` - service 根层边界与子目录职责分工（copilot/github/providers/telemetry）
- `src/services/copilot/AGENTS.md` - 上游 Copilot 调用、native messages 后端适配、telemetry 与 header 规则
- `src/services/github/AGENTS.md` - GitHub 认证、device flow、Copilot token 与 usage 获取边界
- `src/services/providers/AGENTS.md` - 多提供商上游转发、header allowlist、response 头清洗约束
- `src/services/telemetry/AGENTS.md` - telemetry envelope、identity、fire-and-forget 发送约束
- `tests/AGENTS.md` - Bun 测试布局、mock 约定、fixtures 与断言风格
- `tests/generate-content/AGENTS.md` - Gemini/codex 测试约束、stream fixture 与分流断言
- `tests/router/AGENTS.md` - Sticky router 测试模式、fetch/time 注入与 sticky 断言规则
- `claude-plugin/AGENTS.md` - Claude Code plugin/marketplace 目录与 `__SUBAGENT_MARKER__` 约束
- `openspec/AGENTS.md` - 提案、delta spec、validate / archive 工作流
- `router/AGENTS.md` - Sticky router 多实例调度；session-sticky 路由、least-loaded 选择、dashboard、start.sh 编排

## 工作区噪音目录

- `.vendor/`、`.sisyphus/`、`.debates/`、`history/`、`experiments/` 默认不是主运行时逻辑；除非任务明确涉及，否则优先查看 `src/`、`tests/`、`router/`、`claude-plugin/`、`openspec/`
- `.github/instructions/`、`.cursor/rules/`、`README.md` 提供补充流程约束，但实现真相仍以 `src/`、测试与 OpenSpec 为准

## 快速参考

```bash
# 开发
bun run dev              # 带 watch 的开发服务器
bun test                 # 运行所有测试
bun test tests/file.ts   # 运行指定测试

# 质量检查
bun run lint:all --fix   # Lint 并修复
bun run typecheck        # 类型检查

# CLI 标志 (start 命令)
bun run dev -- -M           # Claude 模型使用原生 Messages API（推荐）
bun run dev -- -F           # Smart agent：超出配额预算时自动切换 agent 模式
bun run dev -- -a business  # 使用 business 账户类型
bun run dev -- -v           # 详细日志
bun run dev -- --manual     # 手动审批每个请求
bun run dev -- -r 5         # 速率限制（秒）
bun run dev -- -w           # 超出速率限制时等待而非报错
bun run dev -- --show-token # 显示 token
bun run dev -- -c           # Claude Code 模式
bun run dev -- -g TOKEN     # 指定 GitHub token
bun run dev -- --proxy-env  # 从环境变量读取代理配置
```

## 架构

### 路由结构
- `src/routes/messages/` - Anthropic `/v1/messages`（支持 Responses API 的 vision/tools）
- `src/routes/generate-content/` - Gemini API
- `src/routes/provider/` - Provider-scoped Anthropic-compatible 代理路由
- `src/routes/chat-completions/` - OpenAI-compatible chat completions
- `src/routes/responses/` - GitHub Copilot Responses API
- `src/routes/models/` - 增强版 `/v1/models`，含能力、限制、计费信息

**路由双注册**：所有路由同时注册在 `/` 和 `/v1/` 前缀下（如 `/chat/completions` 和 `/v1/chat/completions`），添加新路由时需同步注册。

### 中间件执行顺序（Hono）

`src/server.ts` 中间件按以下顺序执行：
1. **Logger** — 对 `/v1/messages` 之外的路径启用 Hono logger（messages 路由有自己的日志）
2. **CORS** — 全局跨域
3. **Auth** — API Key 认证中间件（`createAuthMiddleware`，来自 caozhiyuan fork）；`/`、`/usage-viewer`、`/usage-viewer/` 允许未鉴权访问

### 核心服务
- `src/services/copilot/create-chat-completions.ts` - Copilot API 核心调用器（token 刷新、headers、签名重试）
- `src/services/copilot/create-messages.ts` - Claude 模型的原生 Messages API 透传；**同时也是后端适配层**（block 重排、thinking 剥离）
- `src/services/copilot/get-models.ts` - 模型元数据（vision/thinking 限制）
- `src/services/providers/anthropic-proxy.ts` - Provider 上游转发与响应头清洗
- `src/lib/state.ts` - **运行时状态唯一真相源**（tokens、models、config、interactionId）
- `src/lib/config.ts` - 应用配置（见下方配置选项）
- `src/lib/smart-agent.ts` - Smart agent 决策逻辑与缓存
- `src/lib/api-config.ts` - Copilot API 请求头组装（interaction headers、intent、request ID）

### Sticky Router（多实例调度）

`router/` 目录实现多实例 copilot-api 的 session-sticky 路由：

- **三层拆分**：`lib.ts`（纯函数）→ `state.ts`（状态与路由决策）→ `sticky-router.ts`（装配壳）
- **Binding key**：仅在 `x-session-id` 存在时生成 `{session}:{agent}:{model}`，缺失 session 时走 least-loaded
- **Least-loaded**：无已有绑定时，按各端口总请求数选最闲的实例
- **Dashboard**：`:4139` 提供实时 SSE 仪表盘，可视化 binding 和路由历史
- **start.sh**：tmux 编排脚本，一键起多实例 + router + dashboard
- 测试在 `tests/router/`，注入 `fetchImpl`/`now` 参数 mock，不用全局 mock

### 原生 Messages 流程 (`-M` 标志)

**重要约束**：native messages 分支必须在其他 payload 修改之前执行（避免 OpenAI 格式转换污染原始 Anthropic payload）。

```
handleCompletion (handler.ts)
  → if nativeMessages && isClaudeModel → handleWithNativeMessages
    → createMessages (create-messages.ts)
      → reorderAssistantBlocks(payload)   // Vertex AI block 顺序修复
      → buildEnhancedPayload              // adaptive thinking, temperature
      → sendWithSignatureRetry            // 含 stripThinkingBlocks 重试
  → else if responsesApi → handleWithResponsesApi
  → else → handleWithChatCompletions
```

Native messages 的隐含行为：
- 强制 `temperature=1`（optimal for reasoning），移除 `top_p`（Anthropic 不允许同时传 temperature 和 top_p）
- Adaptive thinking 通过模型能力检测（`supports.adaptive_thinking`）而非硬编码模型名
- Vision 自动检测：消息中包含 image 内容时自动添加 `copilot-vision-request: true` header

### Smart Agent (`-F` 标志)

监控配额使用量，超出预算时自动切换 agent 模式：
- 只缓存 `forceAgent=true` 的决策（超预算就是超预算）
- 用 `<=` 而非 `<` 判断阈值，精确触发
- `Math.max(5, ...)` 确保月末至少保留 5 个配额
- 退出保护时有 hysteresis：remaining 必须明显高于 expected + daily margin，避免跨日抖动

### 关键模式

**流式状态机**：所有流式翻译使用状态机，遵循以下不变量：
- `tool_calls` finish_reason = 中间态（保留累加器）
- `stop`/`length`/`content_filter` = 终态（清空累加器）
- 必须在 `finally` 块中关闭 stream

**翻译流程**：每个路由有 `handler.ts` + 可选的 `*-translation.ts` 做格式转换。

**签名重试**：`create-chat-completions.ts` 和 `create-messages.ts` 使用 `isThinkingBlockError` 宽匹配——将响应体 JSON.stringify 后 toLowerCase，包含 "signature" 或 "cannot be modified" 即触发剥离 thinking/reasoning 字段重试。不再依赖精确错误消息字符串。

**后端适配（SRP）**：所有 Vertex AI / Copilot 后端的 workaround 都放在 `create-messages.ts`，不放 `handler.ts`。Handler 只做路由分发。适配包括：
 `reorderAssistantBlocks` — 将 text blocks 移到 tool_use blocks 之前，**但保留 thinking/redacted_thinking blocks 原位**（Vertex AI 同时要求两者）
- `stripThinkingBlocks` — 签名重试时移除 thinking 内容

**错误处理约定**：使用 `HTTPError`（`~/lib/error.ts`）包装底层 Response，保持原始 HTTP status。无全局 error handler，未捕获的错误由 Hono 返回 500。`forwardError` 用于透传上游错误响应。

**无通用重试**：除签名重试外，没有跨请求的通用 retry/backoff 机制。rate limit 的 `-w` 等待模式使用 sleep 延迟；Copilot token 刷新循环失败时会记录错误并在 15 秒后重试。

**Token 刷新**：`src/lib/token.ts` 使用 AbortController 管理刷新循环生命周期。`setupCopilotToken` 先停止旧循环再启动新循环，避免并发泄漏。循环按 `refresh_in - 60s` 提前刷新；首次获取失败会抛错，循环内刷新失败则保留进程并在 15 秒后重试。

## 配置选项

位于 `~/.local/share/copilot-api/config.json`：

| 选项 | 类型 | 默认值 | 说明 |
|:-----|:-----|:-------|:-----|
| `extraPrompts` | `Record<string, string>` | 内置 `gpt-5-mini` exploration + `gpt-5.3-codex` / `gpt-5.4` commentary prompts | 按模型添加额外系统提示 |
| `smallModel` | `string` | `"gpt-5-mini"` | 预热/compact 请求使用的小模型 |
| `compactUseSmallModel` | `boolean` | `true` | compact 请求是否使用小模型 |
| `useFunctionApplyPatch` | `boolean` | `true` | 将自定义 apply_patch 转为 function 类型 |
| `modelReasoningEfforts` | `Record<string, string>` | `gpt-5-mini=low`, `claude-opus-4.6=xhigh`, `claude-opus-4.6-fast=xhigh`, `gpt-5.3-codex=xhigh` | 按模型设置推理努力程度 |

## 关键规则

1. **状态**：不要创建并行状态缓存；只用 `src/lib/state.ts`
2. **流**：必须 `try/finally` + `stream.close()`；4 条清理路径必须同步
3. **工具调用**：chunk 间 ID 必须稳定；`tool_calls` finish_reason 是非终态
4. **日志**：默认使用 `consola`；`src/lib/debug-logger.ts` 目前仍有 `console.*` 调试输出，调整日志体系时要一并处理；`LOG_LEVEL=debug` 开详细日志
5. **导入**：使用 `~` 别名引用 `src/` 路径

## 测试

- Mock 模式：`mock.module("~/services/copilot/create-chat-completions", ...)`
- 使用 `tests/fixtures/` 中的录制数据，不要打真实 API
- 不要硬编码 token 数量（使用 `expect.any(Number)`）

## 已知坑点

| 问题 | 解决方案 |
|:-----|:---------|
| Tool calls 消失 | 不要过滤空的 scaffold chunks；让累加器处理 |
| 多轮工具调用失败 | `finish_reason: "tool_calls"` 是中间态，不要清空 |
| Stream 挂起 | 必须在 finally 块中关闭 |
| Thinking 签名错误 | `isThinkingBlockError` 宽匹配（JSON.stringify + toLowerCase + "signature" 或 "cannot be modified"）自动剥离字段重试 |
| CLI `-ab` 被解析为 `-a -b` | citty 用 mri；短选项别名必须是单字符 |
| Smart agent 缓存了错误状态 | 只缓存 `forceAgent=true`；不要缓存"在预算内" |
| Smart agent 阈值过冲 | 用 `<=` 而非 `<`；用 `Math.max(5, ...)` 保证最低储备 |
| SSE ping 导致 `AI_JSONParseError` | ping 事件必须发 `data: '{"type":"ping"}'`，不能发空字符串 |
| **Vertex AI block 顺序** | assistant 消息中 text blocks 必须在 tool_use blocks 之前（未文档化的 Vertex AI 约束）。由 `reorderAssistantBlocks` 修复。**注意**：thinking/redacted_thinking blocks 不能参与排序——Vertex AI 会校验 "thinking blocks must remain as they were in the original response"（[官方文档](https://docs.anthropic.com/en/docs/build-with-claude/extended-thinking#preserving-thinking-blocks)）。两个约束冲突，修复方案：thinking blocks 保持原位，只在非 thinking slots 中排序 text→tool_use。 |
| **Thinking block 内容问题** | 空 thinking、`"Thinking..."` 占位符、含 `"@"` 的签名可能导致 400。可考虑预防性过滤（参考 caozhiyuan fork）。 |
| **tool_result + text 混合导致 premium 计费** | skill invocations、edit hooks、todo reminders 会在 user 消息中混入 text blocks。`mergeToolResultForClaude` 将它们合并到 tool_result 中，避免额外 premium 消耗。 |
| **Responses API stream ID 不一致** | Copilot 在 added/done 事件返回不同 ID，`@ai-sdk/openai` 会报 "text part not found"。由 `stream-id-sync.ts` 同步 ID。 |
| **`web_search` tool 不被 Copilot 支持** | 当 `useResponsesApiWebSearch=false` 时，responses 路径会在发送前移除 `web_search` tool；默认保留并按配置转发。 |

## 调试 Copilot 后端

使用 `copilot-backend-tester` skill（`.claude/skills/copilot-backend-tester/SKILL.md`）直接测试 Copilot 后端，绕过本地代理。关键要求：必须使用 `X-Initiator: agent` header。

### 调试环境变量

| 变量 | 说明 |
|:-----|:-----|
| `DEBUG_GEMINI_REQUESTS=true` | 打印 Gemini 请求/响应详情（handler + translation） |
| `DEBUG_LOG_DIR` | 自定义 debug 日志目录（默认 `./debug-logs`） |
| `NO_COLOR` | 禁用日志彩色输出 |

## 问题追踪：bd (beads)

本项目使用 **bd (beads)** 进行所有问题追踪。不要使用 markdown TODO 或其他追踪方式。

```bash
bd ready --json          # 查看可开始的工作
bd create "标题" -t bug|feature|task -p 0-4 --json
bd update bd-42 --status in_progress --json
bd close bd-42 --reason "完成" --json
```

工作流：`bd ready` → 认领 → 实现 → 发现新工作？`bd create ... --deps discovered-from:<parent-id>` → `bd close` → 将 `.beads/issues.jsonl` 与代码一起提交。

### 规则

- ✅ 所有任务追踪用 bd；始终加 `--json` 标志
- ✅ 用 `discovered-from` 关联发现的新工作
- ✅ AI 生成的规划文档放 `history/` 目录（不要放项目根目录）
- ❌ 不要创建 markdown TODO 列表或使用外部问题追踪器

## 近期变更 (03/2026)

 **签名重试宽化**：`isThinkingBlockError` 改为 JSON.stringify + toLowerCase 宽匹配 "signature" 或 "cannot be modified"，不再依赖精确错误消息
 **Token 刷新 AbortController**：`setupCopilotToken` 使用 AbortController 管理刷新循环生命周期，避免并发泄漏
 **Interaction metadata**：`api-config.ts` 组装 `X-Interaction-Id` / `X-Agent-Task-Id` / `X-Interaction-Type` 请求头
 **model_picker_enabled 过滤**：`start.ts` 和 `routes/models/route.ts` 过滤掉 `model_picker_enabled === false` 的模型
 **Reasoning ID 长度限制**：Responses 翻译中 id >64 字符的 thinking block 不转为 ResponseInputReasoning
 **Phase 动态检测**：`shouldApplyPhase` 从 `extraPrompts` 检测 `"## Intermediary updates"` 字符串，不再硬编码模型名
 **modelCallId telemetry**：三个 `create-*` service 各自生成 `modelCallId`（UUID）传入 telemetry
 **Usage viewer**：`/usage-viewer` 和 `/usage-viewer/` 路由豁免 auth，提供配额仪表盘
 **Provider proxy**：新增 `/:provider/v1/messages`、`/:provider/v1/models` 与 per-model provider 配置（temperature/topP/topK）
 **Telemetry sampling**：事件采样统一下沉到 `trackEvent()`；`scheduleFeedbackEvents()` 不再重复做 30% 门限

## 近期变更 (02/2026)

 **Thinking block 保留修复**：`reorderAssistantBlocks` 不再移动 thinking/redacted_thinking blocks，修复多轮对话中 Vertex AI 返回 400 "thinking blocks cannot be modified" 的问题
 **Vertex AI block 顺序修复**：`create-messages.ts` 中的 `reorderAssistantBlocks`
 **caozhiyuan/all 合并**：吸收 API key 认证、codex phase、subagent marker，并按文件择优保留本地 telemetry / native messages 兼容逻辑
 **Smart Agent** (`-F`)：超出配额预算时自动切换 agent 模式

## 近期变更 (01/2026)

- **原生 Messages API** (`-M`)：Claude 模型直接透传到 Copilot `/v1/messages`
- **Compact 检测**：自动检测摘要请求，可选使用小模型
- **Models API 增强**：`/v1/models` 返回 thinking_budget、vision 限制、计费信息
- **Thinking 兼容性**：`THINKING_TEXT = "Thinking..."` 默认值，兼容 opencode

## 决策日志

| 日期 | 变更 | 回滚方式 |
|:-----|:-----|:---------|
| 2026-03-14 | isThinkingBlockError 宽化：JSON.stringify + toLowerCase 匹配 "signature" 或 "cannot be modified" | 回退 create-messages.ts 和 create-chat-completions.ts 的 isThinkingBlockError 函数 |
| 2026-03-14 | Token 刷新 AbortController：setupCopilotToken 管理刷新循环生命周期 | 回退 token.ts 的 setupCopilotToken / runCopilotRefreshLoop |
| 2026-03-14 | Interaction headers + modelCallId：api-config.ts 组装请求头，三个 create-* service 生成 modelCallId | 回退 api-config.ts 和三个 create-* service 的 telemetry 修改 |
| 2026-03-14 | model_picker_enabled 过滤：start.ts 和 route.ts 过滤掉未启用模型 | 回退 start.ts 和 routes/models/route.ts 的过滤逻辑 |
| 2026-03-14 | Reasoning ID >64 丢弃 + shouldApplyPhase 动态检测 | 回退 responses-translation.ts 的 MAX_RESPONSES_REASONING_ID_LENGTH 和 shouldApplyPhase |
| 2026-02-22 | reorderAssistantBlocks 保留 thinking blocks 原位：修复 Vertex AI "thinking blocks cannot be modified" 400 错误（两个 Vertex AI 约束冲突：text-before-tool_use vs thinking-immutability） | 回退 create-messages.ts 的 reorderAssistantBlocks 函数到 830e7d8 |
| 2026-02-17 | Vertex AI block 顺序修复：create-messages.ts 中的 reorderAssistantBlocks | 回退 create-messages.ts 的 reorderAssistantBlocks 函数 |
| 2026-02-17 | 合并 caozhiyuan/all：API key 认证、codex phase、subagent marker，并按文件择优保留本地兼容改动 | `git revert <merge-commit>` |
| 2026-02-02 | Smart agent：只缓存 forceAgent=true，用 <=，最低储备 5 | 回退 smart-agent.ts、get-copilot-usage.ts |
| 2026-01-31 | Models API 增强（能力、限制、厂商分组） | 回退 routes/models/route.ts、get-models.ts |
| 2026-01-29 | Compact 请求检测 + anthropic-beta 自动添加 | 回退 handler.ts、config.ts |
| 2026-01-28 | 原生 Messages API (`-M` 标志) | 删除 create-messages.ts，回退 handler.ts |
| 2026-01-10 | interleaved_thinking + useFunctionApplyPatch | 回退 translation 文件 |
