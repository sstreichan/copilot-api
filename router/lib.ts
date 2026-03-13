export interface Instance {
  name: string
  port: number
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

    return [{ name, port }]
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

export function getBindingKey(
  sessionId: string | null,
  agent: string,
  model: string,
): string | null {
  return sessionId ? `${sessionId}:${agent}:${model}` : null
}
