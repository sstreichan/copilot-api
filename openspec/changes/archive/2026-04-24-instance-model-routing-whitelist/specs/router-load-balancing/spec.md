## ADDED Requirements

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
