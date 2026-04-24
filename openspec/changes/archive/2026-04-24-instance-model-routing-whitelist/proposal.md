# Change: Add per-instance model allowlist to sticky router

## Why
`router/lib.ts` and `router/state.ts` currently treat all instances as universally available for any discovered model. There is no way to restrict individual instances to serve only a subset of models. This causes traffic to reach instances that may not support certain models and prevents fine-grained routing control.

## What Changes
- Add optional `allowedModels?: string[]` field to the `Instance` interface in `router/lib.ts`.
- Extend `parseInstances()` to read and sanitize `allowedModels` from config: non-string entries are dropped; missing field defaults to unrestricted.
- In `router/state.ts` `discoverModels()`: after fetching upstream `/v1/models`, filter the discovered list against `allowedModels` before storing in `portToModels`, `modelToPorts`, and `modelDetails`.
- Semantics: missing or empty `allowedModels` = allow all (no restriction); non-empty = strict intersection with upstream-discovered models.
- No glob/wildcard matching — strict equality only.
- Update `~/.local/share/copilot-api/tokens.json` to include `allowedModels` per instance.

## Impact
- Affected specs: `router-load-balancing`
- Affected code:
  - `router/lib.ts`
  - `router/state.ts`
  - `tests/router/lib.test.ts`
  - `tests/router/state.test.ts`
