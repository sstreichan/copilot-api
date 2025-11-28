# CLAUDE.md

**提示**: 本项目使用 [bd (beads)](https://github.com/steveyegge/beads) 进行 issue 跟踪。使用 `bd` 命令代替 markdown TODO 列表。工作流程详情见 AGENTS.md。

**WSL 注意事项**: 如果在 WSL 中使用 beads 遇到 SQLite WAL 锁定错误，需要删除 `.beads/` 目录（在 Windows 端先停止 `bd daemon`），然后在 WSL 中重新运行 `bd init`。这是因为 SQLite WAL 模式在 WSL 挂载的 Windows 文件系统上可能有兼容性问题。

此文件为 Claude Code (claude.ai/code) 提供在处理本仓库代码时的指导。

## Quick Start Checklist

Before making changes:
- ✓ `bun test` passes (all tests green)
- ✓ `bun run lint` clean (no errors)
- ✓ Read: `src/routes/messages/*`, `src/routes/generate-content/*`, `src/lib/state.ts`
- ✓ Understand: **Client API → OpenAI → Copilot** (3-layer translation)
- ✓ Know: Streaming state machine invariants (see below)
- ✓ Set: `LOG_LEVEL=debug` for verbose output (if needed)

### Current Focus Areas (as of 11/28/2025)

Recent work has focused on:
- **Reasoning/Thinking support**: Added `reasoning_text` and `reasoning_opaque` fields for Copilot reasoning features
- **Stream translation refactoring**: Modularized handlers (`handleMessageStart`, `handleThinkingText`, `handleContent`, `handleToolCalls`, `handleFinish`)
- **service_tier compatibility**: Responses API forces `service_tier = null` (unsupported by GitHub Copilot)

## Project Overview

Reverse-engineered proxy for GitHub Copilot API that exposes it as OpenAI and Anthropic compatible endpoints. Translates between different API formats (OpenAI, Anthropic, Gemini) and GitHub Copilot's internal API.

## MCP Servers Usage Strategy

### Serena MCP Server - Semantic Code Operations

**When to use**: For ALL code exploration, analysis, and editing tasks.

**Core principle**: NEVER read entire files unless absolutely necessary. Use symbolic tools to read only what you need.

**Workflow**:
1. **Explore before you code**: Always start with `get_symbols_overview` to understand file structure
2. **Search semantically**: Use `find_symbol` with `name_path` to locate specific classes/functions/types
3. **Understand relationships**: Use `find_referencing_symbols` to see where code is used
4. **Edit precisely**: Use `replace_symbol_body`, `insert_after_symbol`, `insert_before_symbol` for surgical edits
5. **Think before you act**: Call the thinking tools before major operations:
   - `think_about_collected_information` - after gathering code context
   - `think_about_task_adherence` - before making edits
   - `think_about_whether_you_are_done` - before reporting completion

**Symbol name_path matching**:
- Simple name: `createChatCompletions` - matches anywhere
- Relative path: `handleCompletion/streamState` - matches with specific ancestors
- Absolute path: `/handleCompletion` - matches only top-level symbols

**Example workflow**:
```
1. mcp__serena__get_symbols_overview(relative_path="src/routes/messages/handler.ts")
2. mcp__serena__find_symbol(name_path="handleCompletion", include_body=true, depth=1)
3. mcp__serena__find_referencing_symbols(name_path="handleCompletion", relative_path="src/routes/messages/handler.ts")
4. mcp__serena__think_about_task_adherence()
5. mcp__serena__replace_symbol_body(...)
```

### Codex MCP Server - Planning and Review

**When to use**: As a second opinion system when you're uncertain about implementation approaches.

**Use cases**:
- **Before major refactoring**: Consult Codex to validate your refactoring strategy
- **Architecture decisions**: Get a second opinion on structural changes
- **Code review**: Ask Codex to review your planned changes before implementation
- **Complex algorithm design**: Discuss approaches with Codex before coding

**Workflow**:
```
1. [You] Analyze codebase with Serena
2. [You] Draft implementation plan
3. [You] Consult Codex: "I plan to refactor X by doing Y. Does this approach make sense?"
4. [Codex] Provides feedback/alternative approaches
5. [You] Implement with Serena's editing tools
6. [You] Optional: Ask Codex to review the final changes
```

**How to consult**:
```
mcp__codex__codex(
  prompt="I'm planning to add streaming support to the embeddings endpoint.
  Current architecture uses Hono routes with separate handlers.
  Should I follow the same pattern as chat-completions or messages endpoint?",
  cwd="D:\\code\\copilot-api"
)
```

## Cursor Rules Integration

The project maintains detailed Cursor rules in `.cursor/rules/` that supplement this guide:

- **`cursor_rules.mdc`**: Standards for creating and maintaining Cursor rules (structure, formatting, examples)
- **`self_improve.mdc`**: Guidelines for continuously improving rules based on emerging code patterns
- **`taskmaster/`**: Task management and development workflow rules

**When consulting these rules**:
- Use them as a secondary reference for coding patterns not explicitly covered in CLAUDE.md
- They provide Cursor-specific guidance but defer to this file for architectural decisions
- These rules are continuously updated based on code patterns observed in recent commits

## Development Commands

### Build & Type Checking
```bash
bun run build          # Build for production using tsdown
bun run typecheck      # Run TypeScript type checking (no emit)
```

### Development
```bash
bun run dev            # Run with auto-reload (--watch mode)
bun run start          # Run in production mode (NODE_ENV=production)
```

### Code Quality
```bash
bun run lint           # Lint with cache (staged files only)
bun run lint:all       # Lint entire codebase with cache
bun run lint:all --fix # Auto-fix linting issues
bun run knip           # Find unused files, exports, types, dependencies
```

### Testing
```bash
bun test                                    # Run all tests
bun test tests/generate-content/            # Run tests in specific directory
bun test tests/translation.test.ts          # Run specific test file
```

## Key Dependencies

Critical dependencies and their roles in the translation pipeline:

| Dependency | Purpose | Usage in Project |
|:-----------|:--------|:----------------|
| `fetch-event-stream` | SSE stream parsing | Parses GitHub Copilot API SSE responses (`create-chat-completions.ts:43`) |
| `gpt-tokenizer` | Token counting | Usage statistics and rate limiting (`lib/tokenizer.ts`) |
| `hono` | Web framework | Core HTTP server for all API routes |
| `undici` | HTTP client | Calls GitHub Copilot API (底层实现) |
| `tiny-invariant` | Runtime assertions | State machine invariant checks (`lib/state.ts`) |
| `consola` | Unified logging | Replaces console.log, supports debug levels |
| `zod` | Schema validation | Request/response validation for all API endpoints |

## Architecture

### Three-Layer Translation Architecture

The proxy implements a **three-layer translation architecture** to convert between different API formats:

```
Client API Format → OpenAI Format → GitHub Copilot API
                   ↓
            Response Translation (reverse)
```

**Layer 1: Client API → OpenAI Format**
- Anthropic Messages API → OpenAI (`src/routes/messages/anthropic-translation.ts`)
- Gemini API → OpenAI (`src/routes/generate-content/gemini-translation.ts`)
- OpenAI API → passthrough (`src/routes/chat-completions/`)

**Layer 2: OpenAI Format → GitHub Copilot**
- Handled by `src/services/copilot/create-chat-completions.ts`
- Adds GitHub-specific headers (X-Initiator, VSCode-SessionId, etc.)
- Manages token refresh and authentication

**Layer 3: Response Translation (reverse)**
- OpenAI response → Client format
- Handles both streaming (SSE) and non-streaming responses
- Maintains state for multi-chunk streaming translations

### Canonical Schema (Normalized Intermediate)

All translations pass through a canonical OpenAI-compatible format:

```typescript
// Minimal required fields
{
  role: "user" | "assistant" | "system" | "tool"
  content: string | Array<TextPart | ToolCall | ToolResult>
  model: string
  stream?: boolean
  tools?: Array<ToolDefinition>
}
```

**Field handling**:
- Missing fields → Apply provider defaults
- Extra fields → Drop silently
- Incompatible fields → Transform or error

**Direction separation**:
- **Inbound**: External → Normalize → Canonical → ProviderAdapter
- **Outbound**: ProviderEvent → StateMachine → CanonicalEvents → API Encoder

### Route Structure

```
src/routes/
├── chat-completions/    # OpenAI /v1/chat/completions
│   ├── handler.ts       # Request handler
│   └── route.ts         # Hono route definition
├── messages/            # Anthropic /v1/messages
│   ├── handler.ts       # Two-path handler (ChatCompletions vs Responses API)
│   ├── anthropic-translation.ts
│   └── route.ts
├── generate-content/    # Gemini API /v1beta/models/*:generateContent
│   ├── handler.ts       # Unified streaming/non-streaming handler
│   ├── gemini-translation.ts
│   └── route.ts
├── responses/           # GitHub Copilot Responses API (advanced features)
├── embeddings/          # OpenAI /v1/embeddings
├── models/              # OpenAI /v1/models
├── usage/               # Usage dashboard data endpoint
└── token/               # Current Copilot token endpoint
```

### Core Services

**`src/services/copilot/`**
- `create-chat-completions.ts` - Central function that calls GitHub Copilot API
- `create-embeddings.ts` - Embeddings endpoint wrapper
- `create-responses.ts` - Advanced Responses API wrapper
- `get-models.ts` - Model listing

**`src/services/github/`**
- `auth.ts` - OAuth device flow authentication
- `token.ts` - Token management and refresh

**`src/lib/`**
- `state.ts` - Global application state (tokens, models, config)
- `api-config.ts` - Header builders for GitHub API requests
- `rate-limit.ts` - Request rate limiting
- `approval.ts` - Manual request approval (`--manual` flag)
- `tokenizer.ts` - Token counting utilities

### Dual API Support in Messages Route

The `/v1/messages` (Anthropic) endpoint uses **conditional routing** based on model capabilities:

```typescript
// src/routes/messages/handler.ts
if (shouldUseResponsesApi(model)) {
  return handleWithResponsesApi(...)  // Advanced features (vision, tool use)
} else {
  return handleWithChatCompletions(...) // Standard chat completions
}
```

**Responses API** (`/responses`) supports:
- Vision (image inputs)
- Advanced tool use
- Better streaming control

**Chat Completions API** (`/chat/completions`) is used as fallback for models without Responses support.

## Streaming State Machines Pattern

Each provider implements a **streaming state machine** to handle chunk-by-chunk translation. State machines enforce invariants and event ordering.

### Core Lifecycle

```
Init → AccumulatingMetadata → EmittingDeltas → Finalizing → Closed
       ↓ (any state)
       Error → Closed
```

### State Transition Invariants

| Provider   | Invariant                                          | Violation → Error           |
|:-----------|:---------------------------------------------------|:----------------------------|
| Anthropic  | `message_start` must precede any `content_block_*` | ProtocolOrderError          |
| Anthropic  | `tool_use` → `tool_result` pairing required       | MissingToolResultError      |
| Gemini     | Incomplete JSON → switch to accumulate mode        | (internal recovery)         |
| Gemini     | Multi-candidates → select first available          | (log other candidates)      |
| Responses  | `tool_call.delta` and `output_text.delta` can interleave | (handle via output_index) |

### Critical Rules

1. **Tool Call IDs must be stable** across chunks (use `tool_call_${index}` if missing)
2. **State machines cannot revert** (e.g., Closed → any other state = throw)
3. **Single termination event** per stream (duplicate `[DONE]` or `message_stop` → ignore or error)
4. **Always close streams** in `finally` block (see Error Handling pattern)

### Error Classification

#### (Appendix) Streaming Metrics & SLAs (增量)
- 提议观测指标 (占位，实施后在 Decision Log 标记):
  - `idle_timeout_count`  (被动超时次数 / 流数量)
  - `stream_error_rate`   (错误终止流 ÷ 总流)
  - `avg_chunk_latency_ms` (相邻 chunk 平均间隔)
  - `chunks_per_stream`    (用于发现异常长/短流)
  - `stream_resource_limit_hit` (资源上限触发计数)
- 阈值建议: `idle_timeout_count` >5% (5min 窗) 预警；`stream_error_rate` >2% 调查。

#### (Appendix) Streaming Resource Safeguards (已实施)
- **JSON accumulator limit**: `MAX_ACCUMULATOR_BYTES = 5_000_000` (5MB)
  - 位置: `handler.ts:203` (GeminiStreamParser class)
  - 超限行为: throw Error + 结构化日志 (size + rawChunkSample)
  - 目的: 防止异常/恶意超长工具参数或碎片 JSON 导致内存放大
- **Orphan tool call detection**: `[DONE]` 前检测残留 tool calls
  - 位置: `handler.ts:268-277`
  - 检测到残留: console.info({ orphanCount }) + clear()
  - 清理路径: finish_reason, [DONE], parseError, stream error (4 条路径全覆盖)
- 未来扩展: 若需要更多资源限制,可在此处添加 `STREAM_ACCUMULATOR_MAX_ITEMS` 等配置

- **ParsingError**: Invalid JSON chunk → log `rawChunkSample`, return 502
- **ProtocolOrderError**: Event out of sequence → throw immediately
- **ProviderInvarianceBreach**: Provider violated contract → log + fallback or error
- **Timeout/Abort**: Ensure state transitions to Closed

## Critical Pitfalls

### 0. finish_reason Semantics (CRITICAL)
### Multi-Round Tool Calls (Concise)
- Round: assistant tool_calls → client executes → tool response → assistant follow-up
- finish_reason "tool_calls" = intermediate; do NOT clear accumulator
- Completed calls auto-delete by index; accumulator persists for next calls
- Keep empty scaffold chunks (enable later name/args assembly)
- Required tests: multi-round same stream; delayed args; content_filter terminal; resource limit overflow
**Must understand before implementing streaming logic**:

| finish_reason     | State        | Accumulator Action | Client Behavior            |
|:------------------|:-------------|:-------------------|:---------------------------|
| `"tool_calls"`    | Intermediate | Keep alive         | Execute tool, send new request |
| `"stop"`          | Terminal     | Clear              | End conversation           |
| `"length"`        | Terminal     | Clear              | Max tokens reached         |
| `"content_filter"`| Terminal     | Clear              | Content policy violation   |

**Key**: `tool_calls` is the ONLY non-terminal finish_reason. Never clear accumulator at intermediate state.

**When to Clear Accumulator** (4 cleanup paths must stay in sync):
- ✅ Terminal finish_reason (`stop`, `length`, `content_filter`)
- ✅ Stream end with orphans (`[DONE]` event in handler)
- ✅ Parse errors (JSON parsing failure)
- ✅ Stream errors (timeout, abort)

**When NOT to Clear**:
- ❌ `finish_reason: "tool_calls"` (intermediate state, waiting for tool execution)
- ❌ Successful tool call emission (auto-removed from accumulator, no manual clear needed)

### 1. Role Mapping
- **Anthropic**: `system` content → first message or separate field; merge duplicate system messages
- **Gemini**: No traditional `system` → inject as context preamble

### 2. Tool Call IDs
- **Must be stable** across chunks (Anthropic uses server-generated; generate `tool_call_${index}` if missing)
- **ID collision** → throw error (never reassign)

### 3. Stream Closure
- **Always** wrap streaming logic in `try/finally` with `stream.close()`
- Failure to close → resource leak + client hang

### 4. Error Wrapping
- Upstream HTTP non-2xx → `UpstreamHTTPError(code, provider, retriable: boolean)`
- JSON parse failure → return 502 (not 500), log `rawChunkSample`

### 5. Test Snapshots
- **Never** hardcode token counts (provider-dependent, changes frequently)
- Use regex to mask: `usage: { total_tokens: expect.any(Number) }`

## Key Implementation Patterns

### Translation Functions Always Return Types
All translation functions explicitly type their returns:
```typescript
function translateToOpenAI(payload: AnthropicPayload): ChatCompletionsPayload
function translateToAnthropic(response: OpenAIResponse): AnthropicResponse
```

### Stream vs Non-Stream Detection
Use type guards to distinguish response types:
```typescript
const isNonStreaming = (
  response: Awaited<ReturnType<typeof createChatCompletions>>
): response is ChatCompletionResponse =>
  Object.hasOwn(response, "choices")
```

### Error Handling in Streams
Always wrap streaming logic in try/finally to ensure stream closure:
```typescript
return streamSSE(c, async (stream) => {
  try {
    for await (const chunk of response) { ... }
  } catch (error) {
    consola.error("Stream error", error)
  } finally {
    await stream.close()
  }
})
```

### State Management
Global state is managed in `src/lib/state.ts`:
```typescript
export const state: State = {
  copilotToken: undefined,
  githubToken: undefined,
  vsCodeVersion: undefined,
  models: undefined,
  accountType: "individual",
  manualApprove: false,
  // ...
}
```

Update state after authentication, model fetching, etc. Do not create multiple state objects.

SSoT NOTE: `src/lib/state.ts` 是唯一运行时状态来源（tokens, models, config）。禁止引入平行局部缓存复制这些字段；仅通过既有认证/刷新逻辑暴露的函数修改。并发修改需保持原子性（未来若需加锁，在此文件内登记实现策略），避免 token 竞态或模型列表脏读。

## Testing Strategy

### (增量) Defect → Test Traceability
| defect_id | summary                              | patch_ref            | test_files                                                                                 | fixtures | status |
|:----------|:-------------------------------------|:---------------------|:-------------------------------------------------------------------------------------------|:---------|:-------|
| D1        | Empty scaffold filtered (accumulator blocked) | translation.ts:621-633 removal | gemini-tool-call-filtering.test.ts; streaming-name-then-args-single-output.test.ts; streaming-multi-tool-interleaved.test.ts | n/a      | fixed  |
| D3        | Multi-round tool call stream terminated at tool_calls | translation.ts:680-687 condition | streaming-multi-round-toolcall.test.ts; streaming-orphan-toolcall.test.ts (P1-4 修正) | n/a      | fixed  |


### Unit Tests
- **Pure translation functions**: Input/Output snapshots
- **Mock pattern**: `mock.module("~/services/copilot/create-chat-completions", () => ({ createChatCompletions: () => mockResponse }))`

### Streaming Tests
- **Use recorded fixtures** (not live API calls)
- **Assert event sequence** (types and order), NOT specific token values
- **Example**: `expect(events.map(e => e.type)).toEqual(["message_start", "content_block_delta", "message_stop"])`
- **Accumulator inspection (Gemini)**: use `ToolCallAccumulator.getState()` after `finish_reason` or `[DONE]`; expect empty map unless scenario intentionally leaves a pending name-only call.

### Regression Tests
- **ChatCompletions vs Responses equivalence**: Same input → equivalent output (minus advanced features)
- **Test organization**:
  - `tests/generate-content/` - Comprehensive Gemini endpoint tests (7 files)
  - `tests/` - Translation tests, Anthropic tests, core service tests

### Test Utils
`tests/generate-content/_test-utils.ts` provides:
- `asyncIterableFrom()` - Create mock streaming responses
- `createMockChatCompletions()` - Mock the core service
- `makeRequest()` - Test server requests
- `buildNonStreamingResponse()` - Build OpenAI response fixtures

## Adding a New Provider

Follow these steps in order:

1. **Define capability map** (supports: vision, tools, streaming, etc.)
2. **Implement request translator** (Provider → Canonical OpenAI)
3. **Implement response translator** (OpenAI → Provider)
4. **Implement streaming state machine** (if provider supports streaming)
5. **Add tests**: Unit (translation) + Integration (fixtures)
6. **Update Decision Log** (document why this provider, any special handling)
7. **Update provider registry** (if applicable)

## Code Style Requirements

- **ESLint**: Follow `@echristian/eslint-config` rules strictly
- **Imports**: Use `~` alias for `src/` (e.g., `import { state } from "~/lib/state"`)
- **Async/Await**: Prefer async/await over raw promises
- **Type Safety**: All functions must have explicit return types
- **Null Handling**: Use `isNullish()` helper from `~/lib/utils.ts` for null/undefined checks
- **Console Logging**: Use `consola` package (not `console.log`)
  - `consola.info()` for important info
  - `consola.debug()` for verbose logging
  - `consola.error()` for errors
  - `consola.warn()` for warnings

## When Adding New Features

1. **Consult Codex first** if the feature involves:
   - New API endpoint patterns
   - Changes to translation architecture
   - Modifications to streaming state machines

2. **Use Serena for implementation**:
   - Find similar existing implementations: `find_symbol` + `find_referencing_symbols`
   - Read only the necessary symbols: `get_symbols_overview` → `find_symbol(include_body=true)`
   - Edit precisely: `replace_symbol_body` or insert tools

3. **Follow existing patterns**:
   - Route structure: `route.ts` + `handler.ts` + `translation.ts` (if needed)
   - Translation: Client API → OpenAI → Copilot (and reverse)
   - Streaming: State machine pattern with proper cleanup
   - Testing: Mock `create-chat-completions`, use test utils

4. **Write tests**:
   - Place in `tests/` directory
   - Use Bun's `test()`, `expect()`, `mock()`
   - Follow existing mock patterns from `_test-utils.ts`

## Post-Completion Verification Checklist

After implementing a feature or fix, verify before committing:

1. **Tests Pass**:
   ```bash
   bun test                  # All tests must pass
   ```

2. **Code Quality**:
   ```bash
   bun run lint              # No linting errors
   bun run lint:all --fix    # Auto-fix any issues
   bun run typecheck         # No TypeScript errors
   ```

3. **Optional Cleanup**:
   ```bash
   bun run knip              # Check for unused exports/files
   ```

4. **Code Review Checklist**:
   - [ ] No console.log statements (use consola instead)
   - [ ] All functions have explicit return types
   - [ ] Streaming functions close streams in finally block
   - [ ] Translation functions handle missing fields gracefully
   - [ ] No TODO comments left behind (unless documented)
   - [ ] Comments explain *why*, not *what*
   - [ ] Import paths use `~` alias for src/

5. **Git Hygiene**:
   - [ ] Changes are focused (single feature/fix per commit)
   - [ ] Commit message is semantic: `feat:`, `fix:`, `refactor:`, `test:`, `docs:`
   - [ ] Related GitHub issues are referenced

## Critical Notes

- **NEVER modify state management** without understanding the entire auth flow
- **Streaming responses MUST close streams** in finally blocks
- **Translation functions must handle missing fields** gracefully
- **Rate limiting and approval** checks happen in handlers, not services
- **Token refresh is automatic** - handled in `create-chat-completions.ts`
- **X-Initiator header** logic: Check for "assistant" or "tool" roles to determine if agent-initiated

## Decision Log

Track architectural decisions and their rationale:

| Date       | Change                                 | Why                                      | Rollback Strategy           |
|:-----------|:---------------------------------------|:-----------------------------------------|:----------------------------|
| 2025-11-28 | Merge caozhiyuan:all - reasoning support | Copilot thinking features + stream refactor | Revert stream-translation.ts |
| 2025-11-02 | Treat tool_calls as non-terminal (skip clear) | Enable multi-round tool use; prevent accumulator clear at intermediate state | Revert translation.ts:680-687 condition |
| 2025-11-02 | Orphan tool call cleanup (P2-B)        | Prevent orphan residuals at stream end   | Revert handler.ts:268-277   |
| 2025-11-02 | Remove toolCallIdsWithResponses (P2-C) | Dead code cleanup (never used)           | Restore translation.ts:260-267 |
| 2025-11-02 | GeminiStreamParser resource limit      | Prevent memory exhaustion from malformed JSON | Remove handler.ts:203-234 |
| 2025-10-30 | Tool call deduplication (D1/D2 fix)    | Prevent duplicate outputs + preserve context | Revert translation.ts:621-633 & 268-270 |
| 2024-10-18 | JSONL error handling enhancement       | Claude Code compatibility; better errors | Revert handler changes      |
| 2024-10-18 | Streaming idle timeout (10s)           | Prevent indefinite hangs; retry fallback | Adjust timeout threshold    |
| 2024-10-12 | Generate-content test refactoring      | Improved structure and maintainability   | Revert to previous test org |
| 2024-01-XX | Dual ChatCompletions/Responses APIs   | Tool use differences + backward compat   | Merge to single unified API |
| 2024-XX-XX | Gemini multi-candidates → select first | Simplicity; most providers single-choice | Support multi if requested  |
| TBD        | Tool call ID generation strategy       | Stable IDs across chunks required        | Provider-specific fallback  |

*Add new entries when making structural changes*

增量指引: 若条目涉及缺陷修复或新增流式保护/指标，应同步更新：(1) Defect → Test Traceability 表；(2) Streaming Metrics & SLAs 或 Resource Safeguards 状态；(3) 必要时补充日志字段。

## Known Issues & Fixes

Historical bugs that have been resolved. Documented here to prevent regression:

### D1: Early Empty Tool Call Chunk Filtered (Fixed 2025-10-30)
**Problem**: Empty scaffold chunks (`{ id, type, function: { name: "", arguments: "" } }`) were discarded, preventing accumulator from initializing.

**Symptom**: Tool calls never appeared in streaming responses; Gemini CLI showed pure meta-narration ("让我...") without execution.

**Fix**: Removed `hasOnlyEmptyToolCalls` filtering logic in `translation.ts:621-633`. Let accumulator handle complete functionCall assembly.

**Test coverage**:
- `tests/gemini-tool-call-filtering.test.ts`
- `tests/streaming-multi-tool-interleaved.test.ts`

### D2: Pending Assistant Tool_Call Message Removed (Fixed 2025-10-30)
**Problem**: `cleanupMessages` removed assistant messages with tool_calls if no corresponding tool response existed yet.

**Symptom**: Multi-turn conversations lost tool call context; subsequent tool responses couldn't match their invocations.

**Fix**: Removed aggressive filtering in `translation.ts:268-270`. Preserve all assistant tool_call messages even without responses.

**Test coverage**:
- `tests/gemini-message-cleanup.test.ts`

**Prevention**: When modifying message cleanup logic, always verify pending tool_calls are retained.

### Orphan Tool Calls Leaked in Accumulator (Fixed 2025-11-02)
**Problem**: Incomplete tool calls remained in ToolCallAccumulator when stream interrupted (no finish_reason, parseError, or abrupt [DONE]).

**Symptom**: Memory leak + stale tool call state polluting subsequent requests in same session.

**Root causes**:
1. No resource limit on JSON accumulator → unbounded memory growth
2. Missing cleanup on [DONE] early termination
3. parseError caught but accumulator not cleared

**Fix**:
- P1: Added resource limit (5MB) to JSON accumulator (`handler.ts:203-234`)
- P1: Added clear() in parseError catch (`handler.ts:307-310`)
- P1: Added rawChunkSample to all error logs (`handler.ts:305`)
- P2-B: Added orphan detection at [DONE] (`handler.ts:268-277`)
- P2-C: Removed unused toolCallIdsWithResponses construction (`translation.ts:260-267`)

**Test coverage**:
- `tests/generate-content/streaming-orphan-toolcall.test.ts` (4 scenarios: name-only abort, partial args, multi-tool orphan, finish without args)

**Prevention**: Always clear accumulator on: finish_reason, [DONE], parseError, stream error (4 cleanup paths must stay in sync).

**Observability**: INFO logs track all cleanup events:
- `[GEMINI_STREAM] Clearing accumulator on finish_reason`
- `[GEMINI_STREAM] Orphan tool calls at stream end { orphanCount }`
- `[GEMINI_STREAM] Clearing orphan tool calls after parse error`
- `[GEMINI_STREAM] Clearing orphan tool calls after stream error`
- `[GEMINI_STREAM] Complete tool call assembled {immediate|accumulated}`

### D3: Multi-Round Tool Call Stream Terminated at finish_reason: tool_calls (Fixed 2025-11-02)
**Problem**: Accumulator was cleared when `finish_reason: "tool_calls"` arrived, preventing multi-round tool use interactions.

**Symptom**: Gemini CLI reported `fetch failed` when executing multi-tool scenarios. copilot-api logs showed: `[GEMINI_STREAM] Clearing accumulator on finish_reason { finishReason: "tool_calls" }` followed by no subsequent response.

**Root cause**: `translation.ts:681-686` unconditionally called `accumulator.clear()` for ALL finish_reason values, including `"tool_calls"`. However, `"tool_calls"` is an **intermediate state** (not terminal), indicating "complete tool calls sent, waiting for execution and tool response".

**Correct semantics**:
- `finish_reason: "tool_calls"` → Keep accumulator alive (client will execute tool and send new request)
- `finish_reason: "stop" | "length" | "content_filter"` → Clear accumulator (terminal states)

**Fix**: Added condition `&& choice.finish_reason !== "tool_calls"` to skip clearing at intermediate state (`translation.ts:682`).

**Test coverage**:
- `tests/generate-content/streaming-multi-round-toolcall.test.ts` (4 scenarios: verify tool_calls doesn't clear, terminal states do clear, multi-round simulation)
- Modified `streaming-orphan-toolcall.test.ts:P1-4` to use terminal finish_reason ("stop") instead of "tool_calls" for orphan scenario

**Prevention**:
- `finish_reason: "tool_calls"` indicates complete tool calls; incomplete tool calls in real scenarios trigger terminal finish_reason or `[DONE]`
- Always consider finish_reason semantics when modifying accumulator clearing logic

**Observability**: After fix, `[GEMINI_STREAM] Clearing accumulator on finish_reason` log will NOT appear for `tool_calls`, only for terminal states.

## Debugging

### Check server status and auth
```bash
npx copilot-api@latest debug       # Human-readable
npx copilot-api@latest debug --json # JSON format
```

### Enable verbose logging
```bash
bun run dev --verbose
# Or set LOG_LEVEL=debug in environment
```

### Check usage quotas
```bash
npx copilot-api@latest check-usage
```

### Streaming debug tips
- Enable per-chunk logging (see `consola.debug` in streaming handlers)
- Sample every 50th chunk to avoid log flooding
- Log `rawEvent` on parsing errors with truncated preview

### Observability & Logging Schema (增量)
- 结构化日志字段建议: `timestamp`, `level`, `route`, `model`, `correlation_id`, `stream_id`, `chunk_index`, `event_type`, `message`, `rawChunkSample_trunc` (≤256 chars)
- correlation_id: 请求入口生成并贯穿翻译 / 工具调用 / 错误日志
- 原则: 解析失败事件强制输出 truncated 原始片段；正常流按 N(默认50) 采样一条全量 chunk
- 允许在 DEBUG 模式追加字段 `pending_tool_calls`, `accumulator_bytes`
- 统一使用 `consola`；后续若接入集中日志，可直接 JSON.stringify 上述对象

**INFO 日志场景 (已实施)**:
- **Orphan 清理**: `[GEMINI_STREAM] Clearing orphan tool calls after {parse error|stream error}`
- **[DONE] 残留**: `[GEMINI_STREAM] Orphan tool calls at stream end { orphanCount }`
- **finish_reason 清理**: `[GEMINI_STREAM] Clearing accumulator on finish_reason { finishReason }`
- **Tool call 组装**: `[GEMINI_STREAM] Complete tool call assembled {immediate|accumulated} { index, name }`
- **资源上限**: `[GEMINI_STREAM] Accumulator size limit exceeded { size, rawChunkSample }`

这些日志帮助验证 orphan 清理机制正常工作,以及 D1/D2 bug 修复未回归。
