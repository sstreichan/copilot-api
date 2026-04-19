# Change: Add router 429 cooldown

## Why
`router/state.ts` currently treats upstream `429` as a normal passthrough response, so the same throttled instance can keep receiving traffic immediately afterward. This causes avoidable repeated throttling and poor load distribution across instances.

## What Changes
- Add instance-level cooldown tracking in sticky router state, triggered when a proxied upstream response is `429`.
- Use upstream `Retry-After` when valid; otherwise apply a default `60s` instance cooldown.
- When router logs an upstream `429`, include the upstream `Retry-After` header value in the cooldown/error log line for debugging.
- Exclude cooled instances from sticky reuse and least-loaded candidate selection until cooldown expires.
- When all candidate instances for a model are cooling down, return `503` with `Retry-After` (minimum remaining cooldown) instead of sending more upstream traffic.
- Expose `cooldownUntil`, `remainingCooldownMs`, and the raw upstream `Retry-After` value in router status payload and show them on the `:4139` dashboard.
- Render dashboard cooldown values in the user's browser timezone and show remaining cooldown in human-readable `h/m/s` form instead of raw millisecond values.
- Add/extend router tests for cooldown trigger, candidate filtering, sticky rebalance, and all-cooled fallback.

## Impact
- Affected specs: `router-load-balancing`
- Affected code:
  - `router/state.ts`
  - `router/sticky-router.ts`
  - `router/dashboard.html`
  - `tests/router/state.test.ts`
  - `tests/router/proxy.test.ts`
  - `tests/router/integration.test.ts`
