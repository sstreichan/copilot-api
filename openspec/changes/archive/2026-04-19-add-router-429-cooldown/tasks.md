## 1. Implementation

- [x] 1.1 Extend `router/state.ts` state/status types with instance cooldown metadata (port → cooldown-until).
- [x] 1.2 Implement helper logic for parsing `Retry-After`, setting cooldown on upstream `429`, and filtering cooled ports from routing candidates.
- [x] 1.3 Update router request handler to return `503` + `Retry-After` when all model-serving instances are cooling down.
- [x] 1.4 Wire minimal configuration surface for default cooldown duration in router startup path.
- [x] 1.5 Update `router/dashboard.html` to display cooldown data in browser-local time, human-readable remaining duration, and raw upstream `Retry-After` for each instance.
- [x] 1.6 Update router `429` logging to include the upstream `Retry-After` header value whenever present.

## 2. Validation

- [x] 2.1 Add/extend `tests/router/state.test.ts` for cooldown-aware candidate selection and sticky rebalance behavior.
- [x] 2.2 Add/extend `tests/router/proxy.test.ts` for `429` cooldown trigger and `Retry-After` precedence.
- [x] 2.3 Add/extend `tests/router/integration.test.ts` for all-candidates-cooling `503` response, status visibility, raw `Retry-After` observability, and dashboard human-readable cooldown display.
- [x] 2.4 Run `bun test tests/router/` and `bun run typecheck` to verify no regressions.
