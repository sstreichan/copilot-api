# Copilot API Contract

> 基于 `microsoft/vscode-copilot-chat` 源码分析（2026-01-27）

本文档记录 VSCode Copilot Chat 扩展与 GitHub Copilot 后端之间的 API 契约。

## 端点概览

| 端点 | 路径 | 用途 |
|------|------|------|
| Chat Completions | `/chat/completions` | 标准 OpenAI 格式 |
| Responses | `/responses` | OpenAI Responses API（支持 reasoning） |
| Messages | `/v1/messages` | Anthropic 格式（仅 BYOK） |

### 端点选择逻辑

```typescript
// 来源: chatEndpoint.ts:236-249
function selectEndpoint(model: IChatModelInformation): ModelSupportedEndpoint {
  // 优先级：Responses > Messages > ChatCompletions
  if (model.supported_endpoints?.includes('Responses') &&
      !model.supported_endpoints?.includes('ChatCompletions')) {
    return '/responses';
  }
  if (model.supported_endpoints?.includes('Responses')) {
    return '/responses';
  }
  if (enableMessagesApi && model.supported_endpoints?.includes('Messages')) {
    return '/v1/messages';
  }
  return '/chat/completions';
}
```

---

## 请求体结构

### Chat Completions API

```typescript
// 来源: networking.ts:61-119, networking.ts:282-298
interface ChatCompletionsRequestBody {
  // 必选
  messages: CAPIChatMessage[];
  model: string;

  // 可选 - 采样参数
  temperature?: number;           // 默认 1
  top_p?: number;                 // 默认 1
  n?: number;                     // 并行生成数，默认 1
  max_tokens?: number;            // 最大输出 tokens
  stop?: string[];                // 停止词

  // 可选 - 流式
  stream?: boolean;               // 默认 true
  stream_options?: {
    include_usage?: boolean;      // 包含 usage 统计
  };

  // 可选 - 工具调用
  tools?: OpenAiFunctionTool[];
  tool_choice?: 'none' | 'auto' | { type: 'function'; function: { name: string } };

  // 可选 - Anthropic 模型专用
  thinking_budget?: number;       // 思考预算（1024-32000）

  // 可选 - 其他
  prediction?: Prediction;        // 预测输出
  logprobs?: boolean;             // 返回 log 概率
}

interface CAPIChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | ContentPart[];
  name?: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;          // role=tool 时必填

  // Copilot 扩展
  copilot_references?: ICopilotReference[];
  copilot_confirmations?: { state: string; confirmation: any }[];
  copilot_cache_control?: { type: 'ephemeral' };

  // Thinking（历史消息中）
  reasoning_opaque?: string;      // 加密的思考 ID
  reasoning_text?: string;        // 思考摘要文本
}
```

### Responses API

```typescript
// 来源: responsesApi.ts:29-72
interface ResponsesRequestBody {
  model: string;
  input: ResponseInputItem[];

  // 流式
  stream: true;                   // 始终 true

  // 工具
  tools?: ResponsesFunctionTool[];
  tool_choice?: 'none' | 'auto' | { type: 'function'; name: string };

  // 输出控制
  max_output_tokens?: number;
  top_logprobs?: number;          // 0 或 3

  // 状态管理
  previous_response_id?: string;  // 上次响应 ID
  store: false;                   // 始终 false

  // 截断
  truncation: 'auto' | 'disabled';

  // Reasoning
  reasoning?: {
    effort?: 'low' | 'medium' | 'high';  // 默认 medium
    summary?: 'auto' | 'brief' | 'detailed';
  };
  include: ['reasoning.encrypted_content'];

  // 文本控制
  text?: {
    verbosity?: 'low' | 'medium' | 'high';
  };
}

type ResponseInputItem =
  | { role: 'user'; content: ResponseInputContent[] }
  | { role: 'system'; content: ResponseInputContent[] }
  | ResponseOutputMessage              // assistant 消息
  | { type: 'function_call'; name: string; arguments: string; call_id: string }
  | { type: 'function_call_output'; call_id: string; output: string }
  | { type: 'reasoning'; id: string; summary: []; encrypted_content: string };
```

---

## 请求 Headers

### 基础 Headers

| Header | 必选 | 值来源 | 用途 |
|--------|------|--------|------|
| `Authorization` | ✅ | `Bearer ${copilotToken}` | 认证 |
| `X-Request-Id` | ✅ | `generateUuid()` | 请求追踪 |
| `X-GitHub-Api-Version` | ✅ | `2025-05-01` | API 版本 |
| `X-Interaction-Type` | ✅ | `locationToIntent(location)` | 功能标识 |
| `OpenAI-Intent` | ✅ | 同 `X-Interaction-Type` | 功能标识（别名） |

### 额外 Headers

| Header | 必选 | 值来源 | 用途 |
|--------|------|--------|------|
| `X-Interaction-Id` | ✅ | `interactionService.interactionId` | 会话 ID |
| `X-Initiator` | ✅ | `'user'` 或 `'agent'` | 请求发起者 |
| `Copilot-Vision-Request` | ❌ | `'true'`（有图片时） | 标记 vision 请求 |

### Messages API Beta Headers

| Header | 条件 | 值 |
|--------|------|-----|
| `anthropic-beta` | 启用 thinking | `interleaved-thinking-2025-05-14` |
| `anthropic-beta` | 启用 context editing | `context-management-2025-06-27` |
| `anthropic-beta` | 启用 tool search | `advanced-tool-use-2025-11-20` |

多个 beta 特性用逗号连接：`interleaved-thinking-2025-05-14,context-management-2025-06-27`

### OpenAI-Intent 值映射

```typescript
// 来源: chatMLFetcher.ts:1405-1426
function locationToIntent(location: ChatLocation): string {
  switch (location) {
    case ChatLocation.Panel:          return 'conversation-panel';
    case ChatLocation.Editor:         return 'conversation-inline';
    case ChatLocation.EditingSession: return 'conversation-edits';
    case ChatLocation.Notebook:       return 'conversation-notebook';
    case ChatLocation.Terminal:       return 'conversation-terminal';
    case ChatLocation.Other:          return 'conversation-other';
    case ChatLocation.Agent:          return 'conversation-agent';
    case ChatLocation.ResponsesProxy: return 'responses-proxy';
    case ChatLocation.MessagesProxy:  return 'messages-proxy';
  }
}
```

---

## 响应 Headers

| Header | 用途 |
|--------|------|
| `x-request-id` | 请求 ID（用于追踪） |
| `x-github-request-id` | GitHub 请求 ID |
| `X-Copilot-Experiment` | 服务端实验标识 |
| `azureml-model-deployment` | 模型部署 ID |
| `apim-request-id` | Azure API Management ID |

---

## 流式响应格式

### Chat Completions SSE 格式

```
data: {"id":"chatcmpl-xxx","model":"gpt-4","choices":[{"index":0,"delta":{"role":"assistant"}}]}

data: {"id":"chatcmpl-xxx","model":"gpt-4","choices":[{"index":0,"delta":{"content":"Hello"}}]}

data: {"id":"chatcmpl-xxx","model":"gpt-4","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_xxx","function":{"name":"get_weather","arguments":""}}]}}]}

data: {"id":"chatcmpl-xxx","model":"gpt-4","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}

data: [DONE]
```

#### Delta 结构

```typescript
// 来源: stream.ts:185-207
interface ExtendedChoiceJSON {
  index: number;
  delta?: {
    content: string | null;
    role?: string;
    name?: string;
    function_call?: { name: string; arguments: string };
    tool_calls?: IToolCall[];
    copilot_annotations?: {
      CodeVulnerability: ICodeVulnerabilityAnnotation[];
      IPCodeCitations: IIPCodeCitation[];
      TextCopyright: boolean;
      // ... 其他过滤标志
    };
    // Thinking（内联在 delta 中）
    reasoning_opaque?: string;
    reasoning_text?: string;
  };
  finish_reason?: 'stop' | 'length' | 'function_call' | 'tool_calls' | 'content_filter' | 'error' | null;
  logprobs?: ChoiceLogProbs;
  content_filter_results?: Record<FilterReason, { filtered: boolean; severity: string }>;
}
```

### Responses API SSE 格式

```typescript
// 来源: responsesApi.ts:376-512
// 事件类型：
| 'response.output_text.delta'              // 文本增量
| 'response.output_item.added'              // 工具调用开始
| 'response.function_call_arguments.delta'  // 工具参数增量
| 'response.output_item.done'               // 工具/推理完成
| 'response.reasoning_summary_text.delta'   // 推理摘要增量
| 'response.reasoning_summary_part.done'    // 推理摘要完成
| 'response.completed'                      // 响应完成
| 'error'                                   // 错误
```

示例事件：

```
data: {"type":"response.output_text.delta","delta":"Hello","output_index":0,"content_index":0}

data: {"type":"response.output_item.added","output_index":1,"item":{"type":"function_call","name":"get_weather","call_id":"call_xxx"}}

data: {"type":"response.function_call_arguments.delta","output_index":1,"delta":"{\"location\":\""}

data: {"type":"response.completed","response":{"id":"resp_xxx","model":"gpt-4","output":[...],"usage":{...}}}
```

---

## 非流式响应格式

```typescript
// 来源: chatEndpoint.ts:65-112
interface NonStreamResponse {
  id: string;
  model: string;
  created: number;
  choices: Array<{
    index: number;
    message: {
      role: 'assistant';
      content: string | null;
      name?: string;
      tool_calls?: ToolCall[];
    };
    finish_reason: FinishedCompletionReason;
  }>;
  usage: APIUsage;
}

interface APIUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  prompt_tokens_details?: {
    cached_tokens: number;
  };
  completion_tokens_details?: {
    reasoning_tokens: number;
    accepted_prediction_tokens: number;
    rejected_prediction_tokens: number;
  };
}
```

---

## finish_reason 取值

| 值 | 来源 | 含义 |
|----|------|------|
| `stop` | 服务器 | 正常结束 |
| `length` | 服务器 | 达到 max_tokens |
| `function_call` | 服务器 | 函数调用（已废弃） |
| `tool_calls` | 服务器 | 工具调用 |
| `content_filter` | 服务器 | 内容被过滤 |
| `error` | 服务器 | 服务器错误 |
| `client-trimmed` | 客户端 | 客户端主动截断 |
| `Iteration Done` | 客户端 | 未收到 finish_reason |
| `DONE` | 客户端 | 收到 [DONE] |

---

## 错误响应与重试

### 可重试的网络错误

```typescript
// 来源: networking.ts:383-393
const RETRYABLE_ERRORS = [
  'ECONNRESET',
  'ETIMEDOUT',
  'ERR_NETWORK_CHANGED',
  'ERR_HTTP2_INVALID_SESSION',
  'ERR_HTTP2_STREAM_CANCEL',
  'ERR_HTTP2_GOAWAY_SESSION',
  'ERR_HTTP2_PROTOCOL_ERROR',
];
```

### 重试策略

- 首次遇到上述错误时，断开所有连接并重试一次
- 请求超时：30 秒（`requestTimeoutMs = 30 * 1000`）
- 取消请求会发送遥测事件 `networking.cancelRequest`

### 错误响应结构

```typescript
interface APIErrorResponse {
  code: number;
  message: string;
  metadata?: Record<string, any>;
}

// SSE 流中的错误
data: {"choices":null,"error":{"code":500,"message":"Internal server error"}}

// Responses API 错误事件
data: {"type":"error","code":"rate_limit_exceeded","message":"Rate limit exceeded","param":null}
```

### 内容过滤原因

| FilterReason | 描述 |
|--------------|------|
| `hate` | 仇恨言论 |
| `self_harm` | 自我伤害内容 |
| `sexual` | 色情内容 |
| `violence` | 暴力内容 |
| `snippy` | 版权内容 |
| `prompt` | 提示词被过滤 |

---

## 特殊功能

### Thinking / Reasoning

#### 请求配置

**Chat Completions（Anthropic 模型）**:
```typescript
{
  thinking_budget: 10000,  // 1024-32000，会被 maxOutputTokens-1 限制
}
```

**Responses API**:
```typescript
{
  reasoning: {
    effort: 'medium',      // low | medium | high
    summary: 'auto',       // auto | brief | detailed
  },
  include: ['reasoning.encrypted_content'],
}
```

#### 响应中的 Thinking

**Chat Completions 流**:
```typescript
// 在 delta 中
{
  delta: {
    reasoning_opaque: 'copilot-thinking-xxx',  // 加密 ID
    reasoning_text: '分析用户请求...',          // 思考摘要
  }
}
```

**Responses API 流**:
```
data: {"type":"response.reasoning_summary_text.delta","delta":"分析中...","item_id":"reasoning_xxx"}

data: {"type":"response.output_item.done","item":{"type":"reasoning","id":"reasoning_xxx","summary":[{"text":"..."}],"encrypted_content":"..."}}
```

### Tool Calls

#### 请求格式

```typescript
{
  tools: [
    {
      type: 'function',
      function: {
        name: 'get_weather',
        description: '获取天气信息',
        parameters: {
          type: 'object',
          properties: {
            location: { type: 'string' }
          },
          required: ['location']
        }
      }
    }
  ],
  tool_choice: 'auto'  // 或 'none' 或 { type: 'function', function: { name: 'xxx' } }
}
```

#### 响应格式

**Chat Completions**:
```typescript
{
  delta: {
    tool_calls: [{
      index: 0,
      id: 'call_xxx',
      function: {
        name: 'get_weather',
        arguments: '{"location":"北京"}'
      }
    }]
  },
  finish_reason: 'tool_calls'
}
```

**Responses API**:
```
data: {"type":"response.output_item.added","item":{"type":"function_call","name":"get_weather","call_id":"call_xxx"}}

data: {"type":"response.function_call_arguments.delta","delta":"{\"location\":\"北京\"}"}

data: {"type":"response.output_item.done","item":{"type":"function_call","name":"get_weather","call_id":"call_xxx","arguments":"{\"location\":\"北京\"}"}}
```

### Vision

#### 请求格式

```typescript
{
  messages: [
    {
      role: 'user',
      content: [
        { type: 'text', text: '这张图片是什么？' },
        {
          type: 'image_url',
          image_url: {
            url: 'data:image/png;base64,...',
            detail: 'auto',      // auto | low | high
            media_type: 'image/png'  // CAPI 特有
          }
        }
      ]
    }
  ]
}
```

#### 必需 Header

```
Copilot-Vision-Request: true
```

---

## 模型能力

```typescript
// 来源: endpointProvider.ts:37-58
interface IChatModelCapabilities {
  type: 'chat';
  family: string;              // gpt-4.1, claude-sonnet-4.5, etc.
  tokenizer: TokenizerType;
  limits?: {
    max_prompt_tokens?: number;
    max_output_tokens?: number;
    max_context_window_tokens?: number;
    vision?: {
      max_prompt_images?: number;
    };
  };
  supports: {
    parallel_tool_calls?: boolean;
    tool_calls?: boolean;
    streaming?: boolean;
    vision?: boolean;
    prediction?: boolean;
    thinking?: boolean;
  };
}
```

---

## 参考文件

| 文件 | 用途 |
|------|------|
| `src/platform/networking/common/networking.ts` | 请求体构建、postRequest |
| `src/platform/endpoint/node/chatEndpoint.ts` | 端点选择、请求定制 |
| `src/platform/endpoint/node/responsesApi.ts` | Responses API 处理 |
| `src/platform/networking/node/stream.ts` | SSEProcessor |
| `src/platform/networking/common/fetch.ts` | 类型定义 |
| `src/platform/networking/common/openai.ts` | OpenAI 类型 |
| `src/extension/prompt/node/chatMLFetcher.ts` | Headers 设置、intent 映射 |
| `src/platform/endpoint/common/endpointProvider.ts` | 模型能力定义 |
| `src/platform/thinking/common/thinking.ts` | Thinking 类型 |

---

## 与我们 Proxy 的对比

### Headers 差异

| Header | 官方值 | 我们的值 | 状态 |
|--------|--------|----------|------|
| `Authorization` | `Bearer ${token}` | ✅ 一致 | ✅ |
| `X-Request-Id` | `generateUuid()` | ✅ `randomUUID()` | ✅ |
| `X-GitHub-Api-Version` | `2025-05-01` | `2025-10-01` | ✅ 我们更新 |
| `X-Interaction-Type` | `locationToIntent()` | ❌ **缺失** | ⚠️ |
| `OpenAI-Intent` | `locationToIntent()` | ✅ `conversation-agent` | ✅ |
| `X-Interaction-Id` | `interactionService.id` | ❌ **缺失** | ⚠️ |
| `X-Initiator` | `user` / `agent` | ✅ 动态计算 | ✅ |
| `Copilot-Vision-Request` | `true` | ✅ 一致 | ✅ |

**建议**：
- 添加 `X-Interaction-Id`（可用固定值或生成 UUID）
- 添加 `X-Interaction-Type`（与 `OpenAI-Intent` 相同值）

### 类型差异

| 字段 | 官方 | 我们 | 状态 |
|------|------|------|------|
| `finish_reason: function_call` | ✅ | ❌ 缺失 | ⚠️ 已废弃，可忽略 |
| `finish_reason: error` | ✅ | ❌ 缺失 | ⚠️ 建议添加 |
| `completion_tokens_details.reasoning_tokens` | ✅ | ❌ 缺失 | ⚠️ 建议添加 |
| `thinking_budget` | ✅ | ✅ | ✅ |
| `reasoning_text/opaque` | ✅ | ✅ | ✅ |

### 源文件对应

| 官方文件 | 我们的文件 |
|----------|-----------|
| `networking.ts` (IEndpointBody) | `create-chat-completions.ts` (ChatCompletionsPayload) |
| `networking.ts` (postRequest) | `api-config.ts` (copilotHeaders) |
| `stream.ts` (SSEProcessor) | `stream-translation.ts` |
| `openai.ts` (FinishedCompletionReason) | `create-chat-completions.ts` (finish_reason) |
