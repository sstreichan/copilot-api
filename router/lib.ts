export interface Instance {
  name: string
  port: number
  allowedModels?: Array<string>
  disabled?: boolean
}

export function readPort(name: string, fallback: number): number {
  const raw = process.env[name]
  if (!raw) {
    return fallback
  }

  const value = Number.parseInt(raw, 10)
  return Number.isFinite(value) && value > 0 ? value : fallback
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

export function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function parseInstances(value: unknown): Array<Instance> {
  if (!Array.isArray(value)) {
    return []
  }

  return value.flatMap((entry) => {
    if (!isRecord(entry)) {
      return []
    }

    const { name, port } = entry
    if (typeof name !== "string" || typeof port !== "number") {
      return []
    }

    const allowedModels =
      Array.isArray(entry.allowedModels) ?
        entry.allowedModels.filter(
          (model): model is string => typeof model === "string",
        )
      : undefined

    return [{ name, port, allowedModels }]
  })
}

export function parseModelIds(value: unknown): Array<string> {
  if (!isRecord(value) || !Array.isArray(value.data)) {
    return []
  }

  return value.data.flatMap((entry) => {
    if (!isRecord(entry) || typeof entry.id !== "string") {
      return []
    }

    return [entry.id]
  })
}

export function parseModelObjects(
  value: unknown,
): Array<Record<string, unknown>> {
  if (!isRecord(value) || !Array.isArray(value.data)) {
    return []
  }

  return value.data.flatMap((entry) => {
    if (!isRecord(entry) || typeof entry.id !== "string") {
      return []
    }

    return [entry]
  })
}

export function parseModelFromBody(bodyText: string): string {
  try {
    const payload: unknown = JSON.parse(bodyText)
    if (!isRecord(payload) || typeof payload.model !== "string") {
      return ""
    }

    return payload.model
  } catch {
    return ""
  }
}

export function getHeaderValue(req: Request, name: string): string {
  const value = req.headers.get(name)?.trim()
  return value || "_"
}

export interface UpstreamPremiumUsageSnapshot {
  used: number
  total: number
}

export interface UpstreamRateLimitSnapshot {
  remaining: number
  resetAt: string
}

export interface UpstreamHeaderSnapshot {
  premiumUsage: UpstreamPremiumUsageSnapshot | null
  sessionRateLimit: UpstreamRateLimitSnapshot | null
  weeklyRateLimit: UpstreamRateLimitSnapshot | null
}

// /usage has no reset_date; parse only premium usage fields.
export function parsePremiumUsageFromUsageJson(
  value: unknown,
): UpstreamPremiumUsageSnapshot | null {
  if (!isRecord(value)) {
    return null
  }

  const entitlement =
    (
      typeof value.entitlement === "string"
      || typeof value.entitlement === "number"
    ) ?
      Number(value.entitlement)
    : Number.NaN
  const creditsUsed =
    typeof value.credits_used === "number" ? value.credits_used : null
  const remainingPercent =
    typeof value.percent_remaining === "number" ?
      value.percent_remaining
    : Number.NaN
  const overage =
    typeof value.overage_count === "number" ? value.overage_count : Number.NaN

  if (
    !Number.isFinite(entitlement)
    || !Number.isFinite(overage)
    || entitlement < 0
    || overage < 0
    || (creditsUsed !== null
      && (!Number.isFinite(creditsUsed) || creditsUsed < 0))
  ) {
    return null
  }

  if (creditsUsed !== null) {
    return { used: creditsUsed, total: entitlement }
  }

  if (
    !Number.isFinite(remainingPercent)
    || remainingPercent < 0
    || remainingPercent > 100
  ) {
    return null
  }

  const used =
    overage > 0 ?
      entitlement + overage
    : entitlement - (entitlement * remainingPercent) / 100
  if (!Number.isFinite(used) || used < 0) {
    return null
  }

  return { used, total: entitlement }
}

const PREMIUM_QUOTA_SNAPSHOT_HEADER = "x-quota-snapshot-premium_interactions"
const SESSION_RATELIMIT_HEADER = "x-usage-ratelimit-session"
const WEEKLY_RATELIMIT_HEADER = "x-usage-ratelimit-weekly"

const parseFiniteNumber = (value: string | null): number | null => {
  if (value === null) {
    return null
  }

  const trimmed = value.trim()
  if (!trimmed) {
    return null
  }

  const parsed = Number(trimmed)
  return Number.isFinite(parsed) ? parsed : null
}

const parsePremiumUsageSnapshot = (
  raw: string | null,
): UpstreamPremiumUsageSnapshot | null => {
  if (!raw) {
    return null
  }

  const params = new URLSearchParams(raw)
  const total = parseFiniteNumber(params.get("ent"))
  const remainingPercent = parseFiniteNumber(params.get("rem"))
  const overage = parseFiniteNumber(params.get("ov"))

  if (
    total === null
    || remainingPercent === null
    || total < 0
    || remainingPercent < 0
    || remainingPercent > 100
    || (overage !== null && overage < 0)
  ) {
    return null
  }

  const used =
    overage !== null && overage > 0 ?
      total + overage
    : total - (total * remainingPercent) / 100

  if (!Number.isFinite(used) || used < 0) {
    return null
  }

  return { used, total }
}

const parseRateLimitSnapshot = (
  raw: string | null,
): UpstreamRateLimitSnapshot | null => {
  if (!raw) {
    return null
  }

  const params = new URLSearchParams(raw)
  const remaining =
    parseFiniteNumber(params.get("remaining"))
    ?? parseFiniteNumber(params.get("rem"))
  const resetAt = params.get("resetAt") ?? params.get("rst")

  if (
    remaining === null
    || remaining < 0
    || !resetAt
    || Number.isNaN(Date.parse(resetAt))
  ) {
    return null
  }

  return { remaining, resetAt }
}

export function parseUpstreamHeaderSnapshot(
  headers: Headers,
): UpstreamHeaderSnapshot {
  return {
    premiumUsage: parsePremiumUsageSnapshot(
      headers.get(PREMIUM_QUOTA_SNAPSHOT_HEADER),
    ),
    sessionRateLimit: parseRateLimitSnapshot(
      headers.get(SESSION_RATELIMIT_HEADER),
    ),
    weeklyRateLimit: parseRateLimitSnapshot(
      headers.get(WEEKLY_RATELIMIT_HEADER),
    ),
  }
}

interface CopilotQuotaSnapshotFields {
  entitlement: number
  overage: number
  remainingPercent: number
  resetAt: string
}

const parseCopilotQuotaSnapshot = (
  value: unknown,
): CopilotQuotaSnapshotFields | null => {
  if (!isRecord(value)) {
    return null
  }

  const entitlement =
    (
      typeof value.entitlement === "string"
      || typeof value.entitlement === "number"
    ) ?
      Number(value.entitlement)
    : Number.NaN
  const remainingPercent =
    typeof value.percent_remaining === "number" ?
      value.percent_remaining
    : Number.NaN
  const overage =
    typeof value.overage_count === "number" ? value.overage_count : Number.NaN
  const resetAt = typeof value.reset_date === "string" ? value.reset_date : null

  if (
    !Number.isFinite(entitlement)
    || !Number.isFinite(remainingPercent)
    || !Number.isFinite(overage)
    || entitlement < 0
    || remainingPercent < 0
    || remainingPercent > 100
    || overage < 0
    || !resetAt
    || Number.isNaN(Date.parse(resetAt))
  ) {
    return null
  }

  return { entitlement, overage, remainingPercent, resetAt }
}

export function parseUpstreamQuotaSnapshots(
  value: unknown,
): UpstreamHeaderSnapshot {
  const snapshot: UpstreamHeaderSnapshot = {
    premiumUsage: null,
    sessionRateLimit: null,
    weeklyRateLimit: null,
  }

  if (!isRecord(value)) {
    return snapshot
  }

  const premium = parseCopilotQuotaSnapshot(value.premium_interactions)
  if (premium) {
    const used =
      premium.overage > 0 ?
        premium.entitlement + premium.overage
      : premium.entitlement
        - (premium.entitlement * premium.remainingPercent) / 100
    if (Number.isFinite(used) && used >= 0) {
      snapshot.premiumUsage = { used, total: premium.entitlement }
    }
  }

  const session = parseCopilotQuotaSnapshot(value["5Hour-Session-RateLimits"])
  if (session) {
    snapshot.sessionRateLimit = {
      remaining: session.remainingPercent,
      resetAt: session.resetAt,
    }
  }

  const weekly = parseCopilotQuotaSnapshot(value["Weekly-Session-RateLimits"])
  if (weekly) {
    snapshot.weeklyRateLimit = {
      remaining: weekly.remainingPercent,
      resetAt: weekly.resetAt,
    }
  }

  return snapshot
}

export function getBindingKey(
  sessionId: string | null,
  agent: string,
  model: string,
): string | null {
  return sessionId ? `${sessionId}:${agent}:${model}` : null
}
