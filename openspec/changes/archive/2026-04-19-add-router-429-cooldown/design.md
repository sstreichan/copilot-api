## Context

`router/state.ts` currently routes by session-sticky + least-loaded only. Upstream `429` responses are proxied back to clients, but router does not adjust future routing decisions based on throttling history.

## Goals / Non-Goals

- Goals:
  - Prevent immediately reusing recently throttled instances.
  - Keep implementation minimal and local to router state/handler flow.
  - Preserve existing sticky semantics when instances are healthy.
  - Expose cooldown state in `/status` for dashboard and debugging.
- Non-Goals:
  - Implement distributed/global rate control across multiple router processes.
  - Replace least-loaded with weighted or predictive load balancing.
  - Add new persistence layer for cooldown data.

## Decisions

- Decision: Introduce in-memory instance cooldown map keyed by port.
  - Why: Existing routing state is already in-memory (`StickyRouterState`), and cooldown is transient.
  - Alternatives considered:
    - Persist cooldown to file/shared store: rejected as unnecessary complexity for current scope.
    - Model-level cooldown only: rejected for first iteration; instance-level cooldown is simpler and still effective.

- Decision: Trigger cooldown only on upstream `429` response.
  - Why: Matches explicit user request and avoids changing behavior for other status codes.
  - Alternatives considered:
    - Include `5xx`/network failures: deferred; can be added in future change.

- Decision: Add configurable default cooldown seconds and honor `Retry-After` when present.
  - Why: Upstream may provide better backoff hint; fallback ensures deterministic behavior.
  - Alternatives considered:
    - Fixed cooldown only: rejected because `Retry-After` is standard and cheap to support.
  - Decision detail: valid `Retry-After` takes precedence; otherwise the router applies a default `60s` cooldown.

- Decision: Persist the raw upstream `Retry-After` value alongside cooldown state for logs and dashboard observability.
  - Why: When cooldown appears unexpectedly long, operators need to distinguish "router defaulted to 60s" from "upstream explicitly asked for a much longer wait".
  - Alternatives considered:
    - Log only computed `cooldownUntil`: rejected because it hides the original upstream backoff hint.

- Decision: Dashboard presents cooldown in browser-local time and human-readable duration while retaining raw observability fields.
  - Why: Raw ISO UTC timestamps and millisecond counters are hard for operators to read quickly during incident triage.
  - Alternatives considered:
    - Keep UTC ISO string and raw milliseconds only: rejected because it is technically complete but operationally hard to read.
  - Decision detail: dashboard should show local browser timezone for absolute cooldown time, a human-readable remaining duration (`h/m/s`), and raw upstream `Retry-After` when present.

- Decision: If all model candidates are cooling down, return `503` with `Retry-After`.
  - Why: Prevents hammering throttled upstream while giving clients explicit retry signal.
  - Alternatives considered:
    - Still send request to least-loaded cooled instance: rejected; defeats cooldown objective.

## Risks / Trade-offs

- Risk: Short cooldown may still allow frequent throttling loops.
  - Mitigation: Support configuration and `Retry-After`; expose status for tuning.
- Risk: Long cooldown can reduce effective capacity.
  - Mitigation: Keep default conservative, log raw `Retry-After`, and make the dashboard present long waits in a human-readable format.
- Trade-off: In-memory state resets on router restart.
  - Accepted for simplicity; cooldown is intentionally transient.

## Migration Plan

1. Extend router state schema and status payload with cooldown metadata and raw upstream `Retry-After` value.
2. Update port selection to ignore cooled ports and surface cooldown exhaustion as `503`.
3. Update proxy flow to record cooldown on `429` responses and log the upstream `Retry-After` value.
4. Update dashboard rendering to convert cooldown timestamps to browser-local time and human-readable remaining durations.
5. Add router unit/integration tests for the new paths.

## Open Questions

- Cooldown granularity: instance-level (chosen now) vs model-level (future candidate).
