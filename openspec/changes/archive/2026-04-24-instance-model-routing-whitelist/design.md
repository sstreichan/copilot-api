# Design: Per-Instance Model Allowlist

## Overview
Each sticky-router instance can optionally declare an `allowedModels` array in the config JSON. The router uses this list to filter which upstream-discovered models are visible for that instance during routing decisions.

## Interface Change

### router/lib.ts — Instance interface
```ts
interface Instance {
  name: string
  port: number
  allowedModels?: Array<string>
}
```

### router/lib.ts — parseInstances()
When reading instance config, `parseInstances()` checks the `allowedModels` field:
- If absent or not an array → `allowedModels` is left undefined (allow all)
- If an array → filter to only string elements; empty array is valid and means "allow all"

## Filtering Logic

### router/state.ts — discoverModels()
After fetching `/v1/models` upstream:
1. Parse discovered model IDs from the upstream response.
2. If `instance.allowedModels` is a non-empty array → keep only model IDs present in `allowedModels` (strict equality, case-sensitive).
3. If `instance.allowedModels` is missing, undefined, or empty → keep all discovered models.
4. Store only the filtered set in `portToModels`, `modelToPorts`, and `modelDetails`.

## Semantics Summary
| allowedModels value | Behavior |
|---|---|
| undefined / missing | allow all |
| `[]` (empty array) | allow all |
| `["model-a", "model-b"]` | strict intersection only |

## Constraints
- No glob/wildcard matching
- Strict equality only (case-sensitive)
- No changes to `router/sticky-router.ts`, dashboard, CLI flags, or cooldown logic
