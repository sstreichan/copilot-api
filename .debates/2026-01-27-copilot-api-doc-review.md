# Debate: Copilot API Contract Documentation Review

**Date**: 2026-01-27
**Status**: in-progress
**Participants**: Main Agent ↔ Sub Agent (general-purpose)
**Selection Rationale**: general-purpose agent 可以自由读取文件和探索代码库，适合进行全面的文档审查

---

## Background

主代理通过分析 `microsoft/vscode-copilot-chat` 源代码，创建了 `docs/copilot-api-contract.md` 文档（596 行），记录了 GitHub Copilot API 的契约细节。

**审查目标**：
1. 验证文档的技术准确性
2. 发现遗漏的 API 细节
3. 识别与我们代理实现的差距
4. 提出改进建议

**相关文件**：
- `/mnt/d/code/copilot-api/docs/copilot-api-contract.md` - 待审查文档
- `/mnt/d/code/copilot-api/openspec/changes/study-copilot-api-contract/proposal.md` - 研究提案
- `/mnt/d/code/copilot-api/openspec/changes/study-copilot-api-contract/tasks.md` - 任务清单
- `/mnt/d/code/copilot-api/.vendor/vscode-copilot-chat/` - 参考源代码

---

## Round 1

### Main Agent

我创建了 `docs/copilot-api-contract.md` 文档，包含以下内容：

1. **端点概述** - `/chat/completions`, `/responses`, `/v1/messages` 及其选择逻辑
2. **请求体结构** - IEndpointBody 接口的所有字段
3. **请求头** - 完整的 header 列表及值来源
4. **响应格式** - SSE 流式和非流式格式
5. **特殊功能** - thinking、tool_calls、vision 支持
6. **与我们实现的对比** - 发现的差距

**请子代理独立阅读 `.vendor/vscode-copilot-chat/` 源代码，验证我的文档准确性，并指出任何遗漏或错误。**

### Sub Agent

#### 验证通过的部分
- 端点选择优先级与 Messages API gating 逻辑 ✅
- 基础请求 Headers（Authorization / X-Request-Id / X-Interaction-Type / OpenAI-Intent / X-GitHub-Api-Version）✅
- X-Interaction-Id / X-Initiator / Copilot-Vision-Request 来源 ✅
- Responses API 请求体核心字段 ✅
- Responses API SSE 事件类型 ✅
- finish_reason 枚举值 ✅
- 可重试网络错误与 30s 超时 ✅

#### 发现的问题

| 问题 | 严重程度 | 证据 |
|------|----------|------|
| 文档称 `/v1/messages` "仅 BYOK"，源码显示仅受实验开关 `UseAnthropicMessagesApi` + supported_endpoints 控制 | **Major** | chatEndpoint.ts:247-250 |
| `top_logprobs` 文档写 "0 或 3"，实际是 `logprobs ? 3 : undefined` | Minor | responsesApi.ts:50 |
| `content_filter_results` 明确排除了 `snippy`（copyright） | Minor | stream.ts:185-186 |
| `Copilot-Vision-Request` 还需要 `supportsVision` 条件 | Minor | chatMLFetcher.ts:703-705 |

#### 遗漏的内容

**请求 Headers**：
- `User-Agent: GitHubCopilotChat/${version}`
- `X-VSCode-User-Agent-Library-Version`
- `Content-Type: application/json`
- `X-Model-Provider-Preference`
- `modelMetadata.requestHeaders` 注入

**响应 Headers**：
- `Copilot-Edits-Session`（用于 speculative decoding）

**Chat Completions 请求体**：
- `logit_bias`, `presence_penalty`, `frequency_penalty`
- `functions`, `function_call`（legacy）
- `copilot_thread_id`, `copilot_skills`
- `max_completion_tokens`

**Chat Completions SSE**：
- `copilot_errors` / `copilot_references` / `copilot_confirmation` chunk（`choices=null` 的事件）

**Messages API**：
- 完全未覆盖！
- 请求体：`thinking`, `context_management`
- SSE：`message_start`, `content_block_*`, `message_stop`

**Responses API input 细节**：
- assistant message 包含 `id/status/type`
- tool 输出为 `function_call_output`
- tool 输出的图片被转成额外 user input

**其他**：
- `modelMetadata.urlOrRequestMetadata` 会覆盖默认端点选择
- 不支持 streaming 时强制 `stream=false`

#### 改进建议

1. 去掉 "Messages 仅 BYOK" 断言，改为"由实验开关决定"
2. Headers 章节补充自动注入的 `User-Agent`、`Content-Type` 等
3. Chat Completions 请求体增加 OptionalChatRequestParams 完整字段表
4. Responses API 补充 input 映射细节
5. **新增 Messages API 章节**（请求体与 SSE 事件类型）
6. SSE 章节补充 `copilot_errors/copilot_references/copilot_confirmation`
7. Vision header 注明"仅当包含图片且模型支持 vision 才发送"

---

## Round 2

### Main Agent

子代理的审查非常到位，发现了一个 **Major** 问题和多处遗漏。

**我的回应**：

1. **"仅 BYOK" 断言确实有误** - 我在分析时看到了 BYOK 相关的代码路径，但过度推断了。实际上 Messages API 的开启仅取决于实验开关。

2. **Messages API 章节缺失** - 这是最大的遗漏。我之前只分析了 Chat Completions 和 Responses API，没有深入 `messagesApi.ts`。

3. **Headers 遗漏** - `User-Agent`、`Content-Type` 这些"显而易见"的 headers 我确实忽略了，因为它们是标准的。但作为契约文档应该记录完整。

4. **copilot_* SSE 事件** - 这些 Copilot 特有的事件类型我确实没注意到，它们对理解完整的 API 契约很重要。

**下一步建议**：
- 根据审查结果修订文档
- 优先补充 Messages API 章节
- 修正 "仅 BYOK" 的错误表述

### Sub Agent
[等待用户决定是否继续辩论或采纳建议]

---

## Round 3

### Main Agent

已根据子代理审查结果完成文档修订：
- 修正 5 个错误（BYOK、thinking_budget、top_logprobs、content_filter、Vision Header）
- 补充 7 类遗漏内容（Headers、请求体字段、SSE 事件、Messages API 章节、错误处理）
- 新增关于 `/v1/messages` 可直接透传的发现

### Sub Agent

#### 修订验证
所有 12 项修订均已正确实现 ✅

#### 剩余问题

| 问题 | 严重程度 | 建议 |
|------|----------|------|
| Messages API 缺少 `server_tool_use`, `tool_search_tool_result`, `context_management` 细节 | **Major** | 补充 content_block 内部类型 |
| Vision Header 表述仍不够严谨 | Minor | 改为"当有图片且 supportsVision 时必须" |
| "透传 Anthropic" 表述属推论 | Minor | 标记为"潜在优化建议" |
| `choices=null` 可能不严谨 | Minor | 改为"可能为 null 或空数组" |

#### 最终评价

- **完整性评分**：**8.5 / 10**
- **核心建议**：完善 Messages API 的 content_block 内部类型与 server_tool_calls 语义

---

## Round 4

### Main Agent

已根据第 3 轮审查结果修订剩余 4 个问题：
1. 补充 Messages API 的 `server_tool_use`, `tool_search_tool_result`, `context_management` 细节
2. 修正 Vision Header 表述为"当有图片且 supportsVision 时"
3. 将"透传 Anthropic"标记为潜在优化建议
4. 修正 `choices` 表述为"可能为 null 或空数组"

### Sub Agent

#### 修订验证
所有 5 项修订均已正确实现 ✅

#### 最终评分
**9.5 / 10**

**说明**：关键问题已全部修正，Messages API 细节补齐且标注推论边界，整体契约完整度高。

---

## Conclusion

**Date**: 2026-01-27
**Status**: completed
**Outcome**: consensus

### 关键成果

1. **修正了 5 个错误**：BYOK 断言、thinking_budget 触发条件、top_logprobs、content_filter、Vision Header
2. **补充了 7 类遗漏**：Headers、请求体字段、SSE 事件、Messages API、错误处理
3. **新增 Messages API 章节**：包含请求体、SSE 事件、content_block 类型、context_management
4. **发现 Copilot 支持 /v1/messages**：可直接透传 Anthropic 格式（潜在优化）

### 文档评分提升
- 初始评估：发现 1 Major + 3 Minor 问题 + 多处遗漏
- Round 3：8.5 / 10
- Round 4：**9.5 / 10**
