# Design: 原生 Messages API 透传架构

## 架构概览

```
                                    ┌─────────────────────────────────────────┐
                                    │         messages/handler.ts             │
                                    ├─────────────────────────────────────────┤
                                    │ handleCompletion()                      │
                                    │   ├─ !nativeMessages?                   │
                                    │   │   └─ existing logic (unchanged)     │
                                    │   │                                     │
                                    │   ├─ nativeMessages && !claude?         │
                                    │   │   └─ fallback to existing logic     │
                                    │   │                                     │
                                    │   └─ nativeMessages && claude?          │
                                    │       └─ handleWithNativeMessages()     │
                                    └─────────────────────────────────────────┘
                                                        │
                                                        ▼
┌───────────────────────────────────┐   ┌───────────────────────────────────┐
│  create-chat-completions.ts       │   │  create-messages.ts (NEW)         │
│  (existing, unchanged)            │   │  (minimal, passthrough)           │
├───────────────────────────────────┤   ├───────────────────────────────────┤
│ - Token refresh                   │   │ - Token refresh (reuse helper)    │
│ - Headers construction            │   │ - Headers construction            │
│ - POST /chat/completions          │   │ - POST /v1/messages               │
│ - Response parsing                │   │ - Response passthrough            │
└───────────────────────────────────┘   └───────────────────────────────────┘
```

## 模块分解

### 1. CLI 层 (`src/start.ts`)

**新增 flag**:
```typescript
"native-messages": {
  alias: "M",
  type: "boolean",
  default: false,
  description: "Use Copilot's native /v1/messages endpoint for Claude models",
}
```

**职责**: 只解析参数，设置 state

### 2. 状态层 (`src/lib/state.ts`)

**新增字段**:
```typescript
nativeMessages: boolean  // default: false
```

**职责**: 存储配置，供 handler 读取

### 3. 服务层 (`src/services/copilot/create-messages.ts`)

**新文件**，职责单一：
- 构建请求 headers（复用现有 helper）
- POST 到 `/v1/messages`
- 返回原始响应（不做任何转换）

```typescript
export async function createMessages(
  payload: AnthropicMessagesPayload,
  options?: { initiator?: "user" | "agent" }
): Promise<Response | AsyncIterable<SSEMessage>>
```

**设计决策**:
- 不做任何请求体转换（直接透传）
- 不做任何响应体转换（直接透传）
- 复用现有的 token 刷新逻辑

### 4. Handler 层 (`src/routes/messages/handler.ts`)

**修改点**：在 `handleCompletion()` 中添加分支

> ⚠️ **关键约束**：native 分支必须在 payload 改写逻辑（`getSmallModel()`、`mergeToolResultForClaude`）**之前**判断，确保 payload 不被修改。

```typescript
export async function handleCompletion(c: Context) {
  await checkRateLimit(state)
  const anthropicPayload = await c.req.json<AnthropicMessagesPayload>()
  const originalModel = anthropicPayload.model

  // ⚠️ CRITICAL: Native branch MUST be BEFORE any payload modification
  // NEW: Native Messages API branch (early return, no payload modification)
  if (state.nativeMessages && isClaudeModel(anthropicPayload.model)) {
    return await handleWithNativeMessages(c, anthropicPayload, originalModel)
  }

  // UNCHANGED: Existing logic continues here (may modify payload)
  const anthropicBeta = c.req.header("anthropic-beta")
  // ... getSmallModel(), mergeToolResultForClaude() ...
}
```

**新增函数**:
```typescript
const handleWithNativeMessages = async (
  c: Context,
  anthropicPayload: AnthropicMessagesPayload,
  originalModel: string,
) => {
  // Read caller-supplied anthropic-beta header.
  // createMessages() forwards only allowlisted beta values.
  const anthropicBeta = c.req.header("anthropic-beta")

  // Call native /v1/messages endpoint
  const response = await createMessages(anthropicPayload, {
    initiator: getInitiator(anthropicPayload),
    anthropicBeta,
  })

  // Stream: use raw body passthrough (NOT streamSSE reconstruction)
  if (anthropicPayload.stream && response instanceof Response) {
    return c.body(response.body, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
      },
    })
  }

  // Non-stream: return JSON directly
  return c.json(response)
}
```

> ⚠️ **流式透传**：使用 `c.body(response.body)` 直接转发原始 SSE 流，不要用 `streamSSE` 二次解析重构，避免破坏事件格式。

### 5. 辅助函数

**`isClaudeModel()`**:
```typescript
const isClaudeModel = (model: string): boolean =>
  model.toLowerCase().startsWith("claude")
```

## 文件变更矩阵

| 文件 | 变更类型 | 描述 |
|------|----------|------|
| `src/start.ts` | 修改 | 新增 `--native-messages` flag |
| `src/lib/state.ts` | 修改 | 新增 `nativeMessages` 字段 |
| `src/services/copilot/create-messages.ts` | **新增** | 原生 Messages API 调用 |
| `src/routes/messages/handler.ts` | 修改 | 添加分支逻辑 |
| `tests/messages/native-messages.test.ts` | **新增** | 关键测试 |

## 关键设计决策

### 1. 为什么新建 `create-messages.ts` 而不是修改现有服务？

**原因**：
- SRP：现有服务负责 OpenAI 格式，新服务负责 Anthropic 格式
- 避免条件分支污染现有代码
- 更容易测试和维护

### 2. 为什么透传而不是转换？

**原因**：
- Copilot `/v1/messages` 已经是 Anthropic 格式
- 减少代码复杂度
- 减少潜在 bug

### 3. 为什么静默 fallback 而不是报错？

**原因**：
- 用户可能混用 Claude 和 GPT 模型
- 无缝体验，不打断工作流
- 符合用户期望（flag 只是"优先使用"，不是"强制使用"）

## 测试策略

### 需要测试的场景

1. **flag 解析**
   - `--native-messages` 正确设置 state
   - `-M` 短选项工作

2. **分支逻辑**
   - `!nativeMessages` → 现有逻辑
   - `nativeMessages && !claude` → fallback
   - `nativeMessages && claude` → native messages

3. **请求透传**
   - payload 不被修改（包括 model、content）
   - allowlisted `anthropic-beta` header 被转发
   - 非 allowlisted `anthropic-beta` header 被过滤

4. **响应透传**
   - 非流式：JSON 直接返回
   - 流式：原始 SSE 流直接转发（使用 `c.body()`，非 `streamSSE`）

### 不需要测试的场景

- 现有转换逻辑（已有测试）
- token 刷新（已有测试）
- 具体 API 行为（依赖外部服务）

## 风险与缓解

| 风险 | 缓解措施 |
|------|----------|
| `/v1/messages` 端点不稳定 | 用户可随时移除 flag 回退 |
| 部分功能不支持 | 文档明确标注"已验证场景" |
| 模型判断不准确 | 使用 `startsWith("claude")` 宽松匹配 |
