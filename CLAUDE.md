# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Reverse-engineered proxy for GitHub Copilot API exposing OpenAI/Anthropic/Gemini compatible endpoints. Translates between API formats using a **three-layer architecture**:

```
Client API (Anthropic/Gemini/OpenAI) → OpenAI Format → GitHub Copilot API
```

**Exception**: With `-M` flag, Claude models bypass conversion and use Copilot's native `/v1/messages` endpoint directly.

## Quick Reference

```bash
# Development
bun run dev              # Dev server with watch
bun test                 # Run all tests
bun test tests/file.ts   # Run specific test

# Quality
bun run lint:all --fix   # Lint and fix
bun run typecheck        # Type check

# CLI Flags (start command)
bun run dev -- -M           # Native Messages API for Claude models (recommended)
bun run dev -- -F           # Smart agent: auto-switch to agent mode when over quota budget
bun run dev -- -a business  # Use business account type
```

## Architecture

### Route Structure
- `src/routes/messages/` - Anthropic `/v1/messages` (supports Responses API for vision/tools)
- `src/routes/generate-content/` - Gemini API
- `src/routes/chat-completions/` - OpenAI passthrough
- `src/routes/responses/` - GitHub Copilot Responses API
- `src/routes/models/` - Enhanced `/v1/models` with capabilities, limits, billing

### Core Services
- `src/services/copilot/create-chat-completions.ts` - Central Copilot API caller (token refresh, headers, signature retry)
- `src/services/copilot/create-messages.ts` - Native Messages API passthrough for Claude models
- `src/services/copilot/get-models.ts` - Model metadata with vision/thinking limits
- `src/lib/state.ts` - **Single source of truth** for runtime state (tokens, models, config)
- `src/lib/config.ts` - App configuration (see Config Options below)
- `src/lib/smart-agent.ts` - Smart agent decision logic with caching (see Smart Agent below)

### Smart Agent (`-F` flag)

Monitors quota usage and auto-switches to agent mode when over budget:
- `src/lib/smart-agent.ts` - Decision caching and initiator resolution
- `src/services/github/get-copilot-usage.ts` - Quota API and threshold calculation

**Key behaviors**:
- Only caches `forceAgent=true` decisions (over budget stays over budget)
- Uses `<=` for threshold to trigger at exact boundary
- `Math.max(5, ...)` ensures minimum 5 quota reserve at month end

### Key Patterns

**Streaming State Machine**: All streaming translations use state machines with invariants:
- `tool_calls` finish_reason = intermediate (keep accumulator)
- `stop`/`length`/`content_filter` = terminal (clear accumulator)
- Always close streams in `finally` block

**Translation Flow**: Each route has `handler.ts` + optional `*-translation.ts` for format conversion.

**Signature Retry**: Both `create-chat-completions.ts` and `create-messages.ts` auto-retry on "Invalid signature in thinking block" errors by stripping thinking/reasoning fields.

## Config Options

Located in `~/.local/share/copilot-api/config.json`:

| Option | Type | Default | Description |
|:-------|:-----|:--------|:------------|
| `extraPrompts` | `Record<string, string>` | gpt-5 exploration | Model-specific system prompt additions |
| `smallModel` | `string` | `"gpt-5-mini"` | Model for warmup/compact requests |
| `compactUseSmallModel` | `boolean` | `true` | Use small model for Claude Code/OpenCode compact requests |
| `useFunctionApplyPatch` | `boolean` | `true` | Convert custom apply_patch to function type |
| `modelReasoningEfforts` | `Record<string, string>` | - | Per-model reasoning effort levels |

## Critical Rules

1. **State**: Never create parallel state caches; use `src/lib/state.ts` only
2. **Streams**: Always `try/finally` with `stream.close()`; 4 cleanup paths must sync
3. **Tool Calls**: IDs must be stable across chunks; `tool_calls` finish_reason is non-terminal
4. **Logging**: Use `consola` (never `console.log`); `LOG_LEVEL=debug` for verbose
5. **Imports**: Use `~` alias for `src/` paths

## Testing

- Mock pattern: `mock.module("~/services/copilot/create-chat-completions", ...)`
- Use recorded fixtures in `tests/fixtures/`, not live API calls
- Never hardcode token counts (use `expect.any(Number)`)

## Known Pitfalls

| Issue | Solution |
|:------|:---------|
| Tool calls disappear | Don't filter empty scaffold chunks; let accumulator handle |
| Multi-round tools fail | `finish_reason: "tool_calls"` is intermediate, don't clear |
| Stream hangs | Always close in finally block |
| Thinking signature errors | Auto-retried with stripped fields; check logs for warnings |
| CLI `-ab` parsed as `-a -b` | citty uses mri; short option aliases must be single-char |
| Smart agent caches wrong state | Only cache `forceAgent=true` (over budget); never cache "on budget" - would miss threshold crossing |
| Smart agent threshold overshoot | Use `<=` not `<` to trigger at exact threshold; use `Math.max(5, ...)` for minimum reserve |

## Recent Changes (02/2026)

- **Smart Agent** (`-F`): Auto-switch to agent mode when over quota budget; precise threshold with `<=` and minimum 5 reserve

## Recent Changes (01/2026)

- **Native Messages API** (`-M`): Direct passthrough to Copilot `/v1/messages` for Claude models
- **Compact Detection**: Auto-detect Claude Code/OpenCode summarization requests, optionally use small model
- **Models API Enrichment**: `/v1/models` returns thinking_budget, vision limits, billing info
- **Thinking Compatibility**: `THINKING_TEXT = "Thinking..."` default for opencode compatibility

## Decision Log

| Date | Change | Rollback |
|:-----|:-------|:---------|
| 2026-02-02 | Smart agent: cache only forceAgent=true, use <=, min reserve 5 | Revert smart-agent.ts, get-copilot-usage.ts |
| 2026-01-31 | Models API enrichment (capabilities, limits, vendor grouping) | Revert routes/models/route.ts, get-models.ts |
| 2026-01-29 | Compact request detection + anthropic-beta auto-add | Revert handler.ts, config.ts |
| 2026-01-28 | Native Messages API (`-M` flag) | Remove create-messages.ts, revert handler.ts |
| 2026-01-10 | interleaved_thinking + useFunctionApplyPatch | Revert translation files |
