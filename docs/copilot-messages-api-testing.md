# Copilot /v1/messages API 兼容性测试报告

> 测试日期：2026-01-27
> 测试模型：claude-haiku-4.5
> 测试环境：POC 脚本直接调用 Copilot 后端

## 概述

本文档记录了对 GitHub Copilot `/v1/messages` 端点的实际测试结果，验证其与 Anthropic Messages API 的兼容性。

**关键发现**：Copilot `/v1/messages` 端点**高度兼容** Anthropic Messages API（已验证场景），远超我们现有实现的兼容性。

---

## 测试结果汇总

### 请求参数

| 参数 | 测试结果 | 备注 |
|------|----------|------|
| `max_tokens` | ✅ 完全支持 | 支持任意值（包括小值如 10） |
| `temperature` | ✅ 完全支持 | 接受 0-1 范围 |
| `top_p` | ✅ 完全支持 | |
| `top_k` | ⚠️ 接受但未验证效果 | 参数被接受，采样效果未语义验证 |
| `stop_sequences` | ✅ 完全支持 | 输出不含停止词，stop_reason=stop_sequence |
| `stream` | ✅ 完全支持 | |
| `system` (string) | ✅ 完全支持 | |
| `system` (array) | ✅ 完全支持 | TextBlockParam[] 格式 |
| `metadata.user_id` | ✅ 完全支持 | |

### Thinking 参数

| 参数 | 测试结果 | 备注 |
|------|----------|------|
| `thinking.type: enabled` | ✅ 支持 | 需要 max_tokens > budget_tokens |
| `thinking.type: disabled` | ✅ 支持 | 我们的实现不支持此选项 |
| `thinking.budget_tokens` | ✅ 支持 | |

### Tool Choice 变体

| 变体 | 测试结果 |
|------|----------|
| `tool_choice: { type: "auto" }` | ✅ |
| `tool_choice: { type: "any" }` | ✅ |
| `tool_choice: { type: "tool", name: "..." }` | ✅ |
| `tool_choice: { type: "none" }` | ✅ |

### 多轮对话与工具

| 功能 | 测试结果 | 备注 |
|------|----------|------|
| 多轮对话上下文 | ✅ | 正确记住之前消息 |
| `tool_result` 消息 | ✅ | 支持工具结果回传 |
| 自定义工具定义 | ✅ | |

### Stop Reason 映射

| 值 | 测试结果 |
|----|----------|
| `end_turn` | ✅ 正确返回 |
| `max_tokens` | ✅ 正确返回 |
| `tool_use` | ✅ 正确返回 |

### Usage 字段

返回的 usage 对象包含：

```json
{
  "cache_creation": {
    "ephemeral_1h_input_tokens": 0,
    "ephemeral_5m_input_tokens": 0
  },
  "cache_creation_input_tokens": 0,
  "cache_read_input_tokens": 0,
  "input_tokens": 8,
  "output_tokens": 17
}
```

### Headers

| Header | 测试结果 |
|--------|----------|
| `anthropic-beta` | ✅ 接受 |

---

## 流式响应测试

### SSE 事件类型

| 事件 | 状态 | 符合 Anthropic 规范 |
|------|------|---------------------|
| `message_start` | ✅ | ✅ |
| `content_block_start` | ✅ | ✅ |
| `content_block_delta` | ✅ | ✅ |
| `content_block_stop` | ✅ | ✅ |
| `message_delta` | ✅ | ✅ |
| `message_stop` | ✅ | ✅ |

### Content Block 类型

| 类型 | 状态 |
|------|------|
| `text` | ✅ |
| `thinking` | ✅ |
| `tool_use` | ✅ |

### Delta 类型

| 类型 | 状态 |
|------|------|
| `text_delta` | ✅ |

---

## 与现有实现对比

### 我们实现中的问题 vs /v1/messages 原生

| 问题（anthropic-api-compatibility.md） | /v1/messages 原生 | 可修复 |
|----------------------------------------|-------------------|--------|
| `max_tokens` 强制最小 12800 | ✅ 支持任意值 | ✅ |
| `temperature` Responses 路径固定为 1 | ✅ 完全支持 | ✅ |
| `top_k` 不传递 | ✅ 居然支持 | ✅ |
| `stop_sequences` Responses 路径不传 | ✅ 完全支持 | ✅ |
| `thinking: disabled` 类型不支持 | ✅ 支持 | ✅ |
| `tool_choice` 缺少部分变体 | ✅ 全部支持 | ✅ |
| 格式转换开销 | ✅ 无需转换 | ✅ |

### 潜在优化建议

```
当前实现：
Client (Anthropic) → 转换 → OpenAI → Copilot /chat/completions 或 /responses

建议实现：
Client (Anthropic) → 直接透传 → Copilot /v1/messages
```

**优势**：
1. 删除大量转换代码
2. 修复所有上述兼容性问题
3. 获得完整的 Anthropic 原生体验
4. 减少延迟（无转换开销）

**注意事项**：
- 需要验证 `/v1/messages` 端点对所有 Claude 模型可用
- 需要确认模型的 `supported_endpoints` 包含 `Messages`
- 需要处理实验开关 `UseAnthropicMessagesApi`

---

## 语义验证（辩论后补充）

> 以下测试验证参数不仅被接受，而且在语义上生效。

| 功能 | 测试结果 | 验证方法 | 证据 |
|------|----------|----------|------|
| `stop_sequences` | ✅ PASS | 验证输出不包含停止词 | 输出 "1 2 3 4 " 不含 "5"，stop_reason = `stop_sequence` |
| `tool_choice: none` | ✅ PASS | 验证无 tool_use block | Content types 为空，工具未被调用 |
| `thinking: disabled` | ✅ PASS | 验证无 thinking block | 只有 `text` 类型，无 `thinking` |

---

## 已知限制

| 限制 | 描述 |
|------|------|
| 非 Claude 模型 | GPT 模型调用 `/v1/messages` 返回 500 Internal Server Error |
| 仅测试单一模型 | 所有测试基于 `claude-haiku-4.5`，其他 Claude 变体未验证 |

---

## 未测试项

以下功能未在本次测试中覆盖：

- 图像内容 (`ImageBlockParam`)
- 文档内容 (`DocumentBlockParam`)
- 服务器工具 (`server_tool_use`, `bash`, `text_editor`, `web_search`)
- `cache_control` 提示缓存
- `citations` 引用注释
- `context_management` 上下文管理

---

## 测试环境

- **端点**: `https://api.githubcopilot.com/v1/messages`
- **模型**: `claude-haiku-4.5` (实际返回 `claude-haiku-4-5-20251001`)
- **Headers**:
  - `X-Initiator: agent`
  - `copilot-integration-id: vscode-chat`
  - `x-github-api-version: 2025-10-01`

---

## 结论

Copilot `/v1/messages` 端点在已验证场景下提供了**高度的 Anthropic Messages API 兼容性**。

关键功能（`stop_sequences`、`tool_choice`、`thinking`）经语义验证确认生效，不仅仅是"参数被接受"。

对于 Claude 模型的请求，建议考虑直接透传到此端点，以简化代码并提高兼容性。
