# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Reverse-engineered proxy for GitHub Copilot API exposing OpenAI/Anthropic/Gemini compatible endpoints. Translates between API formats using a **three-layer architecture**:

```
Client API (Anthropic/Gemini/OpenAI) → OpenAI Format → GitHub Copilot API
```

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
bun run dev -- -F           # Force X-Initiator: agent
bun run dev -- -a business  # Use business account type

# Issue Tracking (beads)
bd ready                 # Find available work
bd create --title="..." --type=task  # Create issue
bd close <id>            # Mark complete
bd sync                  # Sync before commit
```

## Architecture

### Route Structure
- `src/routes/messages/` - Anthropic `/v1/messages` (supports Responses API for vision/tools)
- `src/routes/generate-content/` - Gemini API
- `src/routes/chat-completions/` - OpenAI passthrough
- `src/routes/responses/` - GitHub Copilot Responses API

### Core Services
- `src/services/copilot/create-chat-completions.ts` - Central Copilot API caller (token refresh, headers)
- `src/lib/state.ts` - **Single source of truth** for runtime state (tokens, models, config)
- `src/lib/api-config.ts` - GitHub API headers (Copilot v0.35.0, VSCode v1.107.0)
- `src/lib/config.ts` - App configuration (extraPrompts, useFunctionApplyPatch, modelReasoningEfforts)

### Key Patterns

**Streaming State Machine**: All streaming translations use state machines with invariants:
- `tool_calls` finish_reason = intermediate (keep accumulator)
- `stop`/`length`/`content_filter` = terminal (clear accumulator)
- Always close streams in `finally` block

**Translation Flow**: Each route has `handler.ts` + optional `*-translation.ts` for format conversion.

## Critical Rules

1. **State**: Never create parallel state caches; use `src/lib/state.ts` only
2. **Streams**: Always `try/finally` with `stream.close()`; 4 cleanup paths must sync (finish_reason, [DONE], parseError, stream error)
3. **Tool Calls**: IDs must be stable across chunks; `tool_calls` is non-terminal
4. **Logging**: Use `consola` (never `console.log`); `LOG_LEVEL=debug` for verbose
5. **Imports**: Use `~` alias for `src/` paths

## MCP Servers

- **Serena**: Semantic code ops - use `find_symbol`, `get_symbols_overview` before reading files
- **Codex**: Second opinion for architecture decisions and code review
- **OpenSpec**: For complex features - `/openspec:proposal`, see `openspec/AGENTS.md`

## Current Focus (01/2026)

- `interleaved_thinking_protocol` - 强制 Claude 在工具调用后输出思考块
- `useFunctionApplyPatch` - 将 custom 类型的 apply_patch 转为 function 类型
- `thinking_budget` + reasoning support (`reasoning_text`, `reasoning_opaque`)
- Premium quota tracking (`getCopilotUsage`)

## Testing

- Mock pattern: `mock.module("~/services/copilot/create-chat-completions", ...)`
- Use recorded fixtures, not live API calls
- Never hardcode token counts (use `expect.any(Number)`)
- Test utils in `tests/generate-content/_test-utils.ts`

## Known Pitfalls

| Issue | Solution |
|:------|:---------|
| Tool calls disappear | Don't filter empty scaffold chunks; let accumulator handle |
| Multi-round tools fail | `finish_reason: "tool_calls"` is intermediate, don't clear |
| Orphan tool calls | Clear on all 4 termination paths |
| Stream hangs | Always close in finally block |
| CLI `-fa` parsed as `-f -a` | citty 基于 mri，遵循 POSIX 短选项规则，别名**必须是单字符**（如 `-F`） |

## Decision Log (Recent)

| Date | Change | Rollback |
|:-----|:-------|:---------|
| 2026-01-10 | PR #20: interleaved_thinking + useFunctionApplyPatch | Revert translation files |
| 2025-12-13 | OpenSpec integration | Remove openspec/ |
| 2025-12-11 | Copilot v0.35.0 | Revert api-config.ts |
| 2025-12-03 | thinking_budget support | Revert translation files |
