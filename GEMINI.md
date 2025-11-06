# Gemini Project Context

## 1. Project Overview
A reverse‑engineered proxy exposing **GitHub Copilot** through multiple provider style APIs:
- OpenAI compatible: `/v1/chat/completions`, `/v1/models`, `/v1/embeddings`, `/v1/responses`
- Anthropic (Claude Messages) compatible: `/v1/messages`, `/v1/messages/count_tokens`
- Gemini style: `/v1beta/models/{model}:generateContent | :streamGenerateContent | :countTokens`

Goal: reuse existing OpenAI / Anthropic / Gemini clients (CLI, IDE, SDK) against Copilot with no or minimal client code changes.

Runtime: **Bun**, **Hono**, streaming fetch, lightweight translation layers. Distributed as a CLI (`copilot-api`).

## 2. Key Capabilities
| Capability | Description |
|------------|-------------|
| Multi‑protocol translation | Normalize disparate request schemas into a unified OpenAI‑like internal payload. |
| Model registry passthrough | Fetch & cache Copilot `/models`, reformat per protocol. |
| Tool / function calls | Bidirectional mapping & streamed argument accumulation (Gemini, Anthropic). |
| Reasoning support | Via Responses API (Anthropic compatibility) including encrypted reasoning content & summary deltas. |
| Streaming adapters | Chunk → event rewriting per protocol (Anthropic, Gemini). |
| Token counting | Local approximation with `gpt-tokenizer`. |
| Rate limiting & manual approval | CLI flags gate request frequency and allow interactive acceptance. |
| Usage dashboard | External static page consuming `/usage`. |
| Extra prompt injection | Model‑specific system guidance (e.g. Codex) injected on certain paths. |

## 3. Architecture Outline
```
CLI (citty)
  subcommands: auth | start | check-usage | debug
Server (Hono)
  Routes:
    /v1/chat/completions         -> create-chat-completions
    /v1/responses                -> create-responses (reasoning/tool rich)
    /v1/messages (+ count_tokens)-> Anthropic translators
    /v1beta/models/*:generate... -> Gemini translators
    /v1/models /v1/embeddings /usage /token
Translation Layers:
  Anthropic <-> Copilot Responses / Chat
  Gemini    <-> OpenAI Chat shape
Services (Copilot upstream): chat, responses, embeddings, models
Lib: state | api-config | tokenizer | tool-call-utils | config | rate-limit | approval | logger / debug-logger
Tests: protocol translation, streaming, tool call assembly, finish reason mapping
```

Flow (simplified): request → translator → normalized payload → upstream Copilot → streamed / non‑streamed response → translator → client.

## 4. Build & Run
Prereq: Bun >= 1.2.x

| Task | Command |
|------|---------|
| Install | `bun install` |
| Dev (watch) | `bun run dev` |
| Start prod | `bun run start` |
| Build dist | `bun run build` (tsdown) |
| Lint | `bun run lint` |
| Type check | `bun run typecheck` |
| Test | `bun test` |
| Release | `bun run release` |

Docker quick start:
```sh
docker build -t copilot-api .
docker run -p 4141:4141 copilot-api
```
Mount a host dir to persist tokens: `-v $(pwd)/copilot-data:/root/.local/share/copilot-api`.

## 5. CLI Commands & Flags
| Command | Purpose |
|---------|---------|
| start | Start server (auth if needed) |
| auth | Device flow only |
| check-usage | Print Copilot quotas/usage |
| debug | Diagnostics JSON/text |

Common flags: `--port`, `--verbose`, `--account-type`, `--manual`, `--rate-limit`, `--wait`, `--github-token`, `--claude-code`, `--show-token`, `--proxy-env`.

## 6. Development Conventions
| Aspect | Convention |
|--------|------------|
| Language | TS ESNext modules, strict, no unused, no fallthrough |
| Imports | `~/*` alias to `src/*` |
| Errors | Throw `HTTPError`; route wrappers call `forwardError` |
| Logging | `consola`; verbose elevates level; handler & debug loggers write structured files |
| Streaming | Iterate server-sent/event-stream style chunks; convert progressively |
| Tools | JSON schema-ish parameters; streaming arguments accumulated & parsed early when possible |
| Token counting | Per model tokenizer selection; counts prompt vs completion separately |
| Tests | Bun test + `mock.module` for isolation; synthetic chunk arrays |

## 7. Notable Internal Modules
| Module | Role |
|--------|------|
| `lib/state` | In‑memory mutable flags, tokens, models |
| `lib/config` | Extra prompts + reasoning effort hints |
| `lib/tool-call-utils` | Gemini tool call accumulation + synthesis |
| `routes/messages/*` | Anthropic request & (Responses / Chat) streaming translation |
| `routes/generate-content/*` | Gemini mapping & stream parser |
| `routes/responses/*` | OpenAI Responses API → Anthropic reasoning stream adapter |
| `services/copilot/*` | Upstream HTTP wrappers |
| `lib/debug-logger` | Structured per-request comparison & raw logging |

## 8. Reasoning & Responses Streaming
Responses API returns richer event types (reasoning, function_call arguments deltas, output item lifecycle). Translation pipeline (`responses-stream-translation.ts`) enforces:
- Open blocks closed before message_stop
- Function call whitespace guard (>20 consecutive whitespace aborts with error event)
- Reasoning block signature format: `encrypted_content@id` enabling cache usage parity with VSCode Copilot Chat
- Stop reason mapping: tool_use vs end_turn vs max_tokens

## 9. Gemini Translation Notes
`translation.ts` maps Gemini models to Copilot models (e.g. `gemini-2.5-codex` → `gpt-5-codex`). For Codex the extra prompt is injected once using a marker `<!-- CODEX_EXTRA_PROMPT_INJECTED -->`. Current gap: countTokens endpoint does **not yet** apply the same injection → underestimates token usage for Codex; align or document when fixed.

## 10. Stability Guards
| Guard | Location | Purpose |
|-------|----------|---------|
| Tool call accumulation map | `tool-call-utils` | Reassembles fragmented arguments safely |
| Whitespace run limit (20) | responses streaming | Halts pathological tool call argument flooding |
| Pending tool call pruning | message translation cleanup | Avoids orphan assistant tool call entries without responses |
| (Planned) Accumulator size cap (5MB) | referenced in CLAUDE.md | Prevents memory blow‑up (verify applied if added) |

## 11. Debug & Observability
| Mechanism | Detail |
|----------|--------|
| Verbose flag | Elevates consola level & richer handler logs |
| `DebugLogger` | Writes structured JSON logs for Gemini requests/chunks & comparisons (env: `DEBUG_GEMINI_REQUESTS=true`) |
| Per handler file logs | Rotated daily, retention 7 days, buffered flush |
| Token count logging | Tokenizer used for local estimates during handlers (guarded by verbose) |

## 12. Extending / Adding Providers
1. Map inbound model ids (avoid collisions)
2. Translate request schema → internal Chat / Responses payload
3. Implement streaming transformer (chunk → provider events)
4. Wire token count endpoint (if provider supports)
5. Register routes in `server.ts`
6. Add targeted tests (translation, streaming finish reasons, tool calls, error edges)

## 13. Testing Strategy Patterns
| Pattern | Aim |
|---------|-----|
| Translation snapshot | Deterministic structure transformation |
| Streaming sequence | Order + finish reason correctness |
| Tool call accumulation | Correct JSON parse upon final fragment |
| Reasoning events | Thinking + signature emission sequence |
| Rate / manual gates | Ordering: approval before upstream call |

## 14. Operational Notes
- Unsanctioned use: GitHub may alter endpoints; breaks are expected risk.
- Rate limiting helps avoid abuse flags.
- Models cached only in process memory.
- Extra prompts alter token footprint; plan for a small (~tens of tokens) increase per request.

## 15. Security / Safety
| Area | Note |
|------|------|
| Tokens | Stored locally; conceal unless `--show-token` |
| Headers | Integration id & user agent mimic official clients |
| CORS | Broad; tighten if deploying publicly |
| Input size | Add / enforce accumulator caps for large streamed JSON (see CLAUDE.md guidance) |

## 16. Known / Potential Gaps
| Gap | Impact | Mitigation Idea |
|-----|--------|-----------------|
| Gemini countTokens no Codex prompt | Token mis-estimate | Inject same prompt or adjust docs |
| Model max token fallback (4096) | Might exceed or underutilize actual limits | Pull from `state.models.capabilities.limits` |
| Responses vs Chat divergence | Feature inconsistency | Unify capability flags per model |
| Streaming error surfaces vary | Client parsing complexity | Normalize error event shape |
| Accumulator memory limit not enforced in code yet | Memory risk on malformed streams | Implement size guard per CLAUDE.md plan |

## 17. Quick Start Examples
```sh
npx copilot-api@latest start --port 4141
curl -X POST http://localhost:4141/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"gpt-4.1","messages":[{"role":"user","content":"Hello"}]}'

curl -X POST http://localhost:4141/v1/messages \
  -H 'Content-Type: application/json' \
  -d '{"model":"gpt-4.1","messages":[{"role":"user","content":"Hi"}]}'
```

## 18. File Map (Selected)
| Path | Purpose |
|------|---------|
| `src/server.ts` | Aggregate route registration |
| `src/routes/generate-content/translation.ts` | Gemini request & stream translation |
| `src/routes/messages/responses-stream-translation.ts` | Responses→Anthropic reasoning stream |
| `src/lib/tool-call-utils.ts` | Tool call synthesis & accumulation |
| `src/lib/tokenizer.ts` | Local token estimation |
| `src/lib/config.ts` | Extra prompts + reasoning effort mapping |
| `tests/generate-content/*` | Gemini translator tests |

## 19. Contribution Checklist
- [ ] Lint & type check clean
- [ ] Tests (new translator logic covered)
- [ ] Streaming edge cases considered (tool calls, reasoning, finish reasons)
- [ ] Token estimator impact reviewed (prompt injections, tool schema changes)
- [ ] Docs (README / GEMINI.md) updated for protocol or model mapping changes

---
Generated for internal agent context (includes synthesized CLAUDE.md stability highlights).