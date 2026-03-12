import { readFileSync, appendFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

// --- Config ---
const PORT = 4140
const TOKENS_PATH = join(homedir(), ".local/share/copilot-api/tokens.json")
const LOG_FILE = "/tmp/sticky-router.log"
const MAX_LINES = 200
const TRIM_TO = 150

// --- Logging (rotate at MAX_LINES) ---
function log(line: string) {
  const entry = `[${new Date().toISOString()}] ${line}\n`
  appendFileSync(LOG_FILE, entry)
  console.log(line)
  try {
    const lines = readFileSync(LOG_FILE, "utf8").split("\n").filter(Boolean)
    if (lines.length > MAX_LINES) {
      writeFileSync(LOG_FILE, lines.slice(-TRIM_TO).join("\n") + "\n")
    }
  } catch {
    return
  }
}

// --- Instance discovery from tokens.json ---
interface Instance {
  name: string
  port: number
}

interface ProxyContext {
  body: string
  req: Request
  url: URL
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function parseInstances(value: unknown): Array<Instance> {
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

function parseModelIds(value: unknown): Array<string> {
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

function parseModelFromBody(bodyText: string): string {
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

const rawInstances: unknown = JSON.parse(readFileSync(TOKENS_PATH, "utf8"))
const instances = parseInstances(rawInstances)

// --- Model mappings ---
const portToModels = new Map<number, Array<string>>()
const modelToPorts = new Map<string, Array<number>>()

async function discoverModels() {
  for (const inst of instances) {
    try {
      const res = await fetch(`http://localhost:${inst.port}/v1/models`)
      const data: unknown = await res.json()
      const models = parseModelIds(data)
      portToModels.set(inst.port, models)
      for (const m of models) {
        const ports = modelToPorts.get(m) || []
        ports.push(inst.port)
        modelToPorts.set(m, ports)
      }
      log(
        `discovered ${inst.name}:${inst.port} → ${models.length} models: ${models.join(", ")}`,
      )
    } catch (e) {
      log(`FAILED to discover ${inst.name}:${inst.port}: ${formatError(e)}`)
    }
  }
  log(
    `total: ${modelToPorts.size} unique models across ${portToModels.size} instances`,
  )
}

// --- Routing state ---
const sessionBindings = new Map<string, number>()
let globalRoundRobin = 0

function pickPort(
  sessionId: string | null,
  model: string,
): { port: number; reason: string } | null {
  const ports = modelToPorts.get(model)
  if (!ports || ports.length === 0) return null

  // Binding key = sid + model (same session, different models get independent bindings)
  const bindingKey = sessionId ? `${sessionId}:${model}` : null

  // Sticky: existing binding for this sid+model combo
  if (bindingKey) {
    const bound = sessionBindings.get(bindingKey)
    if (bound !== undefined && ports.includes(bound)) {
      return { port: bound, reason: "sticky" }
    }
  }

  // Round-robin among ports that serve this model
  const port = ports[globalRoundRobin % ports.length]
  globalRoundRobin++

  const hadBinding = bindingKey ? sessionBindings.has(bindingKey) : false
  if (bindingKey) {
    sessionBindings.set(bindingKey, port)
  }

  return { port, reason: hadBinding ? "rebalance" : "new" }
}

// --- Start ---
await discoverModels()

Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url)

    // GET /status — debug endpoint
    if (url.pathname === "/status" && req.method === "GET") {
      return Response.json({
        instances: instances.map((i) => ({
          name: i.name,
          port: i.port,
          models: portToModels.get(i.port),
        })),
        sessionBindings: Object.fromEntries(sessionBindings),
        modelToPorts: Object.fromEntries(modelToPorts),
      })
    }

    // GET /v1/models — union of all instance models
    if (url.pathname === "/v1/models" && req.method === "GET") {
      const allModels = new Set<string>()
      for (const models of portToModels.values()) {
        for (const m of models) allModels.add(m)
      }
      return Response.json({
        object: "list",
        data: [...allModels].map((id) => ({ id, object: "model" })),
      })
    }

    // --- Proxy all other requests ---
    // Read body to extract model (then forward the same body)
    const bodyText = await req.text()
    const model = parseModelFromBody(bodyText)

    const sessionId = req.headers.get("x-session-id")

    // No model in body → round-robin to any instance
    if (!model) {
      const allPorts = instances.map((i) => i.port)
      const port = allPorts[globalRoundRobin % allPorts.length]
      globalRoundRobin++
      log(`sid=${sessionId || "-"} → :${port} model=(none) reason=nomodel`)
      return proxyTo(port, { body: bodyText, req, url })
    }

    const result = pickPort(sessionId, model)
    if (!result) {
      log(`NO PORT sid=${sessionId || "-"} model=${model}`)
      return Response.json(
        { error: `no instance serves model: ${model}` },
        { status: 502 },
      )
    }

    log(
      `sid=${sessionId || "-"} → :${result.port} model=${model} reason=${result.reason}`,
    )
    return proxyTo(result.port, { body: bodyText, req, url })
  },
})

async function proxyTo(port: number, context: ProxyContext): Promise<Response> {
  const { body, req, url } = context
  const targetUrl = `http://localhost:${port}${url.pathname}${url.search}`
  const headers = new Headers(req.headers)
  headers.delete("host")

  try {
    const upstream = await fetch(targetUrl, {
      method: req.method,
      headers,
      body: req.method !== "GET" && req.method !== "HEAD" ? body : undefined,
    })

    // Transparent proxy: pass through status, headers, body (including SSE streams)
    return new Response(upstream.body, {
      status: upstream.status,
      headers: upstream.headers,
    })
  } catch (e) {
    log(`PROXY ERROR → :${port}: ${formatError(e)}`)
    return Response.json(
      { error: `upstream connection failed on port ${port}` },
      { status: 502 },
    )
  }
}

log(
  `router started on :${PORT}, ${instances.length} instances: ${instances.map((i) => `${i.name}:${i.port}`).join(", ")}`,
)
console.log(`\n  Sticky router listening on http://localhost:${PORT}\n`)
