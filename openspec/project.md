# Project Context

## Purpose
Reverse-engineered proxy for GitHub Copilot API that exposes it as OpenAI and Anthropic compatible endpoints. Translates between different API formats (OpenAI, Anthropic) and GitHub Copilot's internal API.

## Tech Stack
- **Runtime**: Bun (v1.3+)
- **Language**: TypeScript (strict mode)
- **Framework**: Hono (web framework)
- **Build**: tsdown
- **Testing**: Bun's built-in test runner
- **Linting**: ESLint with @echristian/eslint-config

## Project Conventions

### Code Style
- Use `~` alias for `src/` imports (e.g., `import { state } from "~/lib/state"`)
- Prefer async/await over raw promises
- All functions must have explicit return types
- Use `consola` package for logging (never `console.log`)
- Use `isNullish()` helper for null/undefined checks
- Comments explain *why*, not *what*

### Architecture Patterns
- **Three-Layer Translation**: Client API → OpenAI Format → GitHub Copilot API
- **Route Structure**: Each endpoint has `route.ts` + `handler.ts` + optional `translation.ts`
- **Streaming State Machines**: For chunk-by-chunk translation with proper cleanup
- **Single State Source**: `src/lib/state.ts` is the only runtime state (tokens, models, config)

### Testing Strategy
- Unit tests for pure translation functions using input/output snapshots
- Streaming tests use recorded fixtures (not live API calls)
- Mock pattern: `mock.module()` for service dependencies
- Never hardcode token counts in tests (use regex to mask)
- Test organization: `tests/` directory mirrors `src/routes/`

### Git Workflow
- Branch from `dev` for features
- Semantic commits: `feat:`, `fix:`, `refactor:`, `test:`, `docs:`

## Domain Context
- **GitHub Copilot API**: Proprietary API used by VS Code Copilot extension
- **Translation**: Converting between Anthropic Messages API, OpenAI Chat Completions
- **Streaming**: Server-Sent Events (SSE) for real-time responses
- **Tool Calls**: Function calling support across different API formats
- **Responses API**: GitHub's advanced API supporting vision and complex tool use

## Important Constraints
- Never modify state management without understanding entire auth flow
- Streaming responses MUST close streams in finally blocks
- Translation functions must handle missing fields gracefully
- Token refresh is automatic in `create-chat-completions.ts`
- Tool call IDs must be stable across chunks

## External Dependencies
- **GitHub Copilot API**: Primary upstream API (api.individual.githubcopilot.com)
- **OAuth Device Flow**: GitHub authentication for token acquisition
- **gpt-tokenizer**: Token counting for usage statistics
- **fetch-event-stream**: SSE stream parsing

## Key Files
- `src/lib/state.ts` - Global application state (SSoT)
- `src/services/copilot/create-chat-completions.ts` - Central Copilot API caller
- `src/routes/messages/handler.ts` - Anthropic API translation
- `CLAUDE.md` - Comprehensive development guide
