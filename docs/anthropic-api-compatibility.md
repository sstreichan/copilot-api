# Anthropic API Compatibility

This document describes the differences between the official Anthropic Messages API and our implementation.

**Official API Reference**: https://platform.claude.com/docs/en/api/messages/create.md

---

## Request Parameters

### Supported Parameters

| Parameter        | Type                         | Required | Default  | Status                    |
| ---------------- | ---------------------------- | -------- | -------- | ------------------------- |
| `max_tokens`     | `number`                     | ✅       | -        | ⚠️ Partial                |
| `messages`       | `MessageParam[]`             | ✅       | -        | ✅ Full                   |
| `model`          | `string`                     | ✅       | -        | ✅ Full                   |
| `system`         | `string \| TextBlockParam[]` | ❌       | -        | ✅ Full                   |
| `temperature`    | `number`                     | ❌       | `1.0`    | ⚠️ Partial                |
| `top_p`          | `number`                     | ❌       | -        | ✅ Full                   |
| `top_k`          | `number`                     | ❌       | -        | ⚠️ Defined but not passed |
| `stop_sequences` | `string[]`                   | ❌       | -        | ⚠️ Partial                |
| `stream`         | `boolean`                    | ❌       | `false`  | ✅ Full                   |
| `metadata`       | `{ user_id?: string }`       | ❌       | -        | ✅ Full                   |
| `service_tier`   | `"auto" \| "standard_only"`  | ❌       | -        | ⚠️ Defined but not passed |
| `thinking`       | `ThinkingConfigParam`        | ❌       | disabled | ⚠️ Partial                |
| `tool_choice`    | `ToolChoice`                 | ❌       | `auto`   | ⚠️ Partial                |
| `tools`          | `ToolUnion[]`                | ❌       | -        | ⚠️ Partial                |

### Parameter Details

#### `max_tokens`

- **Official**: Passed directly to API
- **Our Implementation**:
  - Chat Completions path: ✅ Passed as `payload.max_tokens`
  - Responses API path: ⚠️ Forced minimum of `12800` via `Math.max(payload.max_tokens, 12800)`

```json
// Official API
{
  "max_tokens": 1024
}

// Our translation to Responses API
{
  "max_output_tokens": 12800  // Minimum enforced
}
```

#### `temperature`

- **Official**: Passed directly to API
- **Our Implementation**:
  - Chat Completions path: ✅ Passed as `payload.temperature`
  - Responses API path: ❌ Always hardcoded to `1` (ignores request value)

```json
// Official API
{
  "temperature": 0.7
}

// Our translation to Responses API
{
  "temperature": 1  // Ignored, always 1
}
```

#### `top_k`

- **Official**: Supported
- **Our Implementation**: Defined in types but **never passed** to backend
- **Reason**: GitHub Copilot backend does not support `top_k`

```json
// Official API
{
  "top_k": 40
}

// Our implementation: Silently dropped
```

#### `stop_sequences`

- **Official**: Passed directly to API
- **Our Implementation**:
  - Chat Completions path: ✅ Passed as `stop`
  - Responses API path: ❌ Not passed (silently dropped)

```json
// Official API
{
  "stop_sequences": ["END", "STOP"]
}

// Our translation to Chat Completions
{
  "stop": ["END", "STOP"]
}

// Our translation to Responses API
// stop_sequences is NOT included
```

#### `thinking`

- **Official**: Supports `enabled` and `disabled` types
- **Our Implementation**:
  - Type definition: Only supports `enabled` (missing `disabled`)
  - Chat Completions path: ✅ Translated to `thinking_budget`
  - Responses API path: ⚠️ Parameter is **ignored**; reasoning is always enabled with effort from model config

```json
// Official API - Enabled
{
  "thinking": {
    "type": "enabled",
    "budget_tokens": 8000
  }
}

// Official API - Disabled (NOT SUPPORTED by us)
{
  "thinking": {
    "type": "disabled"
  }
}

// Our type definition
interface {
  thinking?: {
    type: "enabled"  // Missing "disabled"
    budget_tokens?: number
  }
}
```

#### `tool_choice`

- **Official**: Includes `disable_parallel_tool_use` option
- **Our Implementation**:
  - Missing `disable_parallel_tool_use` option in type definition
  - Responses API path: `parallel_tool_calls` is hardcoded to `true`

```json
// Official API
{
  "tool_choice": {
    "type": "auto",
    "disable_parallel_tool_use": true
  }
}

// Our type definition
{
  "tool_choice": {
    "type": "auto"  // Missing disable_parallel_tool_use
  }
}
```

#### `tools`

- **Official**: Supports custom tools and server tools (bash, text_editor, web_search)
- **Our Implementation**: Only supports custom tools

```json
// Official API - Custom tool
{
  "tools": [
    {
      "name": "get_weather",
      "description": "Get weather info",
      "input_schema": {
        "type": "object",
        "properties": {
          "city": { "type": "string" }
        }
      }
    }
  ]
}

// Official API - Server tools (NOT SUPPORTED by us)
{
  "tools": [
    {
      "type": "bash_20250124",
      "name": "bash"
    },
    {
      "type": "text_editor_20250124",
      "name": "str_replace_editor"
    },
    {
      "type": "web_search_20250305",
      "name": "web_search",
      "max_uses": 5
    }
  ]
}
```

### Unsupported Content Block Types

| Block Type                      | Status     | Notes                                                        |
| ------------------------------- | ---------- | ------------------------------------------------------------ |
| `TextBlockParam`                | ✅         |                                                              |
| `ImageBlockParam`               | ⚠️ Partial | Base64 only, URL source not supported                        |
| `ToolUseBlockParam`             | ✅         |                                                              |
| `ToolResultBlockParam`          | ⚠️ Partial | Content only supports text/image, not document/search_result |
| `ThinkingBlockParam`            | ✅         |                                                              |
| `DocumentBlockParam`            | ❌         |                                                              |
| `SearchResultBlockParam`        | ❌         |                                                              |
| `RedactedThinkingBlockParam`    | ❌         |                                                              |
| `ServerToolUseBlockParam`       | ❌         |                                                              |
| `WebSearchToolResultBlockParam` | ❌         |                                                              |

### Unsupported Features

| Feature         | Description                                  |
| --------------- | -------------------------------------------- |
| `cache_control` | Prompt caching breakpoints on content blocks |
| `citations`     | Document citation annotations                |

---

## Response Parameters

### Supported Response Fields

| Field           | Type             | Status           |
| --------------- | ---------------- | ---------------- |
| `id`            | `string`         | ✅ Full          |
| `type`          | `"message"`      | ✅ Full          |
| `role`          | `"assistant"`    | ✅ Full          |
| `model`         | `string`         | ✅ Full          |
| `content`       | `ContentBlock[]` | ⚠️ Partial       |
| `stop_reason`   | `StopReason`     | ⚠️ Partial       |
| `stop_sequence` | `string \| null` | ⚠️ Always `null` |
| `usage`         | `Usage`          | ⚠️ Partial       |

### Response Content Blocks

| Block Type                 | Status |
| -------------------------- | ------ |
| `TextBlock`                | ✅     |
| `ThinkingBlock`            | ✅     |
| `ToolUseBlock`             | ✅     |
| `RedactedThinkingBlock`    | ❌     |
| `ServerToolUseBlock`       | ❌     |
| `WebSearchToolResultBlock` | ❌     |

### `stop_reason` Values

| Value           | Official | Our Implementation |
| --------------- | -------- | ------------------ |
| `end_turn`      | ✅       | ✅                 |
| `max_tokens`    | ✅       | ✅                 |
| `stop_sequence` | ✅       | ✅                 |
| `tool_use`      | ✅       | ✅                 |
| `pause_turn`    | ✅       | ❌ Not mapped      |
| `refusal`       | ✅       | ❌ Not mapped      |

**Note**: `content_filter` from backend is mapped to `end_turn` (degraded).

```json
// Official API response
{
  "id": "msg_123",
  "type": "message",
  "role": "assistant",
  "model": "claude-sonnet-4-20250514",
  "content": [
    {
      "type": "text",
      "text": "Hello!"
    }
  ],
  "stop_reason": "end_turn",
  "stop_sequence": null,
  "usage": {
    "input_tokens": 10,
    "output_tokens": 5,
    "cache_creation_input_tokens": 0,
    "cache_read_input_tokens": 0,
    "service_tier": "standard"
  }
}
```

### `usage` Fields

| Field                         | Official | Our Implementation           |
| ----------------------------- | -------- | ---------------------------- |
| `input_tokens`                | ✅       | ✅                           |
| `output_tokens`               | ✅       | ✅                           |
| `cache_creation_input_tokens` | ✅       | ❌ Not emitted               |
| `cache_read_input_tokens`     | ✅       | ⚠️ Optional (when available) |
| `service_tier`                | ✅       | ❌ Not emitted               |
| `cache_creation`              | ✅       | ❌ Not supported             |
| `server_tool_use`             | ✅       | ❌ Not supported             |

---

## Streaming Events

### Supported Events

| Event Type            | Status |
| --------------------- | ------ |
| `message_start`       | ✅     |
| `content_block_start` | ✅     |
| `content_block_delta` | ✅     |
| `content_block_stop`  | ✅     |
| `message_delta`       | ✅     |
| `message_stop`        | ✅     |
| `ping`                | ✅     |
| `error`               | ✅     |

**Note**: `ping` events are generated by the handler layer (periodic keepalive) or forwarded from upstream (Responses API path), not by the translation layer.

### Delta Types

| Delta Type         | Status |
| ------------------ | ------ |
| `text_delta`       | ✅     |
| `thinking_delta`   | ✅     |
| `signature_delta`  | ✅     |
| `input_json_delta` | ✅     |

---

## Backend Limitations

Our implementation proxies to GitHub Copilot backend, which has its own limitations:

| Parameter      | OpenAI         | Copilot | Notes                           |
| -------------- | -------------- | ------- | ------------------------------- |
| `temperature`  | ✅             | ✅      | Reasoning models: not supported |
| `top_p`        | ✅             | ✅      |                                 |
| `top_k`        | ✅ (Responses) | ❌      | Not supported by Copilot        |
| `service_tier` | ✅             | ❌      | Explicitly unsupported          |

---

## Full Request Example

```json
{
  "model": "claude-sonnet-4-20250514",
  "max_tokens": 4096,
  "messages": [
    {
      "role": "user",
      "content": "Hello, Claude!"
    }
  ],
  "system": "You are a helpful assistant.",
  "temperature": 0.7,
  "top_p": 0.9,
  "top_k": 40,
  "stream": true,
  "thinking": {
    "type": "enabled",
    "budget_tokens": 8000
  },
  "tools": [
    {
      "name": "get_weather",
      "description": "Get current weather",
      "input_schema": {
        "type": "object",
        "properties": {
          "location": { "type": "string" }
        },
        "required": ["location"]
      }
    }
  ],
  "tool_choice": {
    "type": "auto"
  },
  "metadata": {
    "user_id": "user-123"
  }
}
```

### What Gets Passed Through

| Field            | Chat Completions Path              | Responses API Path                       |
| ---------------- | ---------------------------------- | ---------------------------------------- |
| `max_tokens`     | ✅ `payload.max_tokens`            | ⚠️ `Math.max(payload.max_tokens, 12800)` |
| `temperature`    | ✅ `payload.temperature`           | ❌ Hardcoded `1`                         |
| `top_p`          | ✅ `payload.top_p`                 | ✅ `payload.top_p ?? null`               |
| `top_k`          | ❌ Dropped                         | ❌ Dropped                               |
| `stop_sequences` | ✅ `stop`                          | ❌ Dropped                               |
| `thinking`       | ✅ Translated to `thinking_budget` | ⚠️ Ignored; reasoning always enabled     |

---

## Full Response Example

```json
{
  "id": "msg_abc123",
  "type": "message",
  "role": "assistant",
  "model": "claude-sonnet-4-20250514",
  "content": [
    {
      "type": "thinking",
      "thinking": "Let me analyze this request...",
      "signature": "abc123..."
    },
    {
      "type": "text",
      "text": "Hello! I'm Claude, an AI assistant."
    }
  ],
  "stop_reason": "end_turn",
  "stop_sequence": null,
  "usage": {
    "input_tokens": 25,
    "output_tokens": 150,
    "cache_creation_input_tokens": 0,
    "cache_read_input_tokens": 0
  }
}
```

---

## Behavioral Differences

Beyond parameter support, our implementation has behavioral differences that affect how messages are processed.

### Prompt Augmentation (Chat Completions Path, Claude Models)

When using Claude models with `thinking_budget`, our implementation injects additional prompts:

1. **System Prompt Injection**: Adds `<interleaved_thinking_protocol>` rules to enforce thinking blocks after tool results
2. **User Message Injection**: Prepends `<system-reminder>` to the first user message

This affects reproducibility and content consistency compared to the official API.

### System Prompt Concatenation

When `system` is an array of text blocks, the concatenation strategy differs:

| Path | Join Strategy |
|------|---------------|
| Chat Completions | `\n\n` (paragraph separator) |
| Responses API | ` ` (single space) |

### thinking_budget Clamping

The `budget_tokens` value is clamped to model capabilities:

```
final_budget = max(
  min(budget_tokens, model.max_thinking_budget, model.max_output_tokens - 1),
  model.min_thinking_budget ?? 1024
)
```

If `budget_tokens` is not provided or the model doesn't support thinking, the parameter is silently ignored.

### metadata.user_id Parsing (Responses API)

The Responses API path parses `metadata.user_id` to extract additional fields:

```typescript
// Pattern: user_{safety_id}_account..._session_{cache_key}
safety_identifier = match(/user_([^_]+)_account/)[1]
prompt_cache_key = match(/_session_(.+)$/)[1]
```

### tool_choice Mapping Details

| Anthropic Value | Mapped To |
|-----------------|-----------|
| `auto` | `auto` |
| `any` | `required` |
| `tool` (with name) | `{ type: "function", name }` |
| `tool` (no name) | `auto` (fallback) |
| `none` | `none` |

### tool_result Reordering (Chat Completions Path)

Within a user message, `tool_result` blocks are moved to the front and emitted as separate `tool` role messages before other content. This differs from the official API which preserves content order.

### Thinking Signature Requirement (Responses API)

Only thinking blocks with signatures containing `@` are converted to reasoning content:

```typescript
if (block.signature && block.signature.includes("@")) {
  // Converted to reasoning
}
```

Thinking blocks without `@` in their signature are silently dropped.

### Consecutive Same-Role Messages

Official API documentation states:
> "Consecutive `user` or `assistant` turns in your request will be combined into a single turn."

Our implementation does NOT merge consecutive same-role messages; each message is processed individually.

### Streaming Usage

In streaming mode, `usage` is only fully populated in the final `message_delta` event:

| Event | `output_tokens` |
|-------|-----------------|
| `message_start` | Always `0` |
| `message_delta` (final) | Actual count |

### Error Event Simplification

All streaming errors are converted to a generic message:

```json
{
  "type": "error",
  "error": {
    "type": "api_error",
    "message": "An unexpected error occurred during streaming."
  }
}
```

Original error details from the backend are not preserved.

### Tool Arguments Parsing (Non-Streaming)

In non-streaming responses, tool call arguments are parsed with `JSON.parse()` without try/catch. Malformed JSON from the backend will cause an unhandled exception.

---

## Version

- **Anthropic API Version**: `2023-06-01`
- **Document Updated**: 2026-01-26
