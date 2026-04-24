# router-load-balancing Specification

## Purpose
TBD - created by archiving change add-router-429-cooldown. Update Purpose after archive.
## Requirements
### Requirement: Cooldown throttled instances on HTTP 429

The router MUST place an instance into temporary cooldown when that instance returns HTTP `429` for a proxied request.

#### Scenario: 429 triggers cooldown for the responding instance
- **GIVEN** a model is served by multiple instances and one selected instance responds with HTTP `429`
- **WHEN** the router processes that upstream response
- **THEN** the router records a cooldown-until timestamp for that instance
- **AND** subsequent routing decisions treat that instance as temporarily unavailable until cooldown expiry

#### Scenario: Retry-After header overrides default cooldown duration
- **GIVEN** an upstream `429` response includes a valid `Retry-After` value
- **WHEN** cooldown duration is computed
- **THEN** the router uses `Retry-After` as cooldown duration
- **AND** falls back to a default `60s` cooldown only when `Retry-After` is absent or invalid

#### Scenario: 429 logs include Retry-After for debugging
- **GIVEN** an upstream `429` response includes a `Retry-After` header
- **WHEN** the router logs the cooldown/error event for that response
- **THEN** the log entry includes the upstream `Retry-After` value

### Requirement: Exclude cooled instances from selection

The router MUST exclude instances in cooldown from both sticky reuse and least-loaded candidate selection.

#### Scenario: Sticky binding points to cooled instance
- **GIVEN** a session binding points to an instance currently in cooldown
- **WHEN** a new request for the same binding key arrives
- **THEN** the router does not reuse the cooled binding target
- **AND** reselects among non-cooled instances serving the model

#### Scenario: Least-loaded ignores cooled ports
- **GIVEN** at least one model-serving instance is in cooldown and at least one is available
- **WHEN** the router performs model port selection
- **THEN** least-loaded evaluation considers only non-cooled candidates

### Requirement: Return overload response when all candidates cooling down

If every model-serving instance is cooling down, the router MUST reject the request locally instead of proxying to throttled upstream instances.

#### Scenario: All model candidates are cooling down
- **GIVEN** all instances serving the requested model are currently in cooldown
- **WHEN** the router handles the request
- **THEN** the router returns HTTP `503`
- **AND** includes a `Retry-After` header reflecting the minimum remaining cooldown across candidates

### Requirement: Expose cooldown state in status payload

The router status payload MUST include current cooldown metadata per instance for observability.

#### Scenario: Status includes cooldown metadata
- **GIVEN** one or more instances are in cooldown
- **WHEN** `/status` is requested
- **THEN** the response includes cooldown-until or remaining-cooldown fields for affected instances
- **AND** unaffected instances remain represented as available in the same payload schema

#### Scenario: Status includes raw upstream Retry-After value
- **GIVEN** a cooldown was derived from an upstream `Retry-After` header
- **WHEN** `/status` is requested before the cooldown expires
- **THEN** the response includes the raw upstream `Retry-After` value for that affected instance

### Requirement: Show cooldown state on the dashboard

The dashboard served on `:4139` MUST render cooldown metadata for each instance using the router status payload.

#### Scenario: Dashboard shows active cooldown values
- **GIVEN** the router status payload contains `cooldownUntil` or `remainingCooldownMs` for an instance
- **WHEN** the dashboard renders the instance table
- **THEN** the `:4139` page displays those cooldown values for that instance

#### Scenario: Dashboard renders local time and human-readable duration
- **GIVEN** the router status payload contains `cooldownUntil`, `remainingCooldownMs`, and an upstream `Retry-After` value for an instance
- **WHEN** the dashboard renders in a user's browser
- **THEN** the absolute cooldown time is displayed in the browser's local timezone
- **AND** the remaining cooldown is displayed in human-readable `h/m/s` form instead of raw milliseconds
- **AND** the dashboard also shows the raw upstream `Retry-After` value for debugging

### Requirement: Restrict per-instance discoverable models via allowlist

Each router instance MAY declare an `allowedModels` array. When `allowedModels` is non-empty, the router MUST make available for routing on that instance only models present in that array AND discovered upstream.

#### Scenario: missing allowlist keeps all discovered models
- **GIVEN** an instance config with no `allowedModels` field
- **WHEN** the router discovers models for that instance
- **THEN** all upstream-discovered models are stored as available for routing

#### Scenario: empty allowlist keeps all discovered models
- **GIVEN** an instance config with `allowedModels: []`
- **WHEN** the router discovers models for that instance
- **THEN** all upstream-discovered models are stored as available (empty = unrestricted)

#### Scenario: non-empty allowlist filters discovered models to intersection
- **GIVEN** an instance config with `allowedModels: ["model-a", "model-b"]`
- **AND** upstream discovers `["model-a", "model-b", "model-c"]`
- **WHEN** the router stores models for that instance
- **THEN** only `model-a` and `model-b` are stored; `model-c` is excluded

#### Scenario: disallowed model is excluded from routing
- **GIVEN** an instance has `allowedModels: ["model-a"]`
- **AND** upstream also serves `model-b`
- **WHEN** a request for `model-b` arrives
- **THEN** the instance is not a candidate for `model-b` routing
