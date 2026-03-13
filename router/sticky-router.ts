import { readFileSync, appendFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

function readPort(name: string, fallback: number): number {
  const raw = process.env[name]
  if (!raw) {
    return fallback
  }

  const value = Number.parseInt(raw, 10)
  return Number.isFinite(value) && value > 0 ? value : fallback
}

const ROUTER_PORT = readPort("ROUTER_PORT", 4140)
const DASHBOARD_PORT = readPort("DASHBOARD_PORT", 4139)
const TOKENS_PATH =
  process.env.TOKENS_PATH
  || join(homedir(), ".local/share/copilot-api/tokens.json")
const LOG_FILE = process.env.STICKY_ROUTER_LOG_FILE || "/tmp/sticky-router.log"
const MAX_LINES = 200
const TRIM_TO = 150
const HISTORY_LIMIT = 200
const DASHBOARD_FILE = Bun.file(new URL("./dashboard.html", import.meta.url))
const SSE_RETRY_MS = 2000
const encoder = new TextEncoder()

interface Instance {
  name: string
  port: number
}

interface ProxyContext {
  body: string
  req: Request
  url: URL
}

interface RouteRecord {
  ts: string
  sid: string
  agent: string
  model: string
  provider: string
  port: number
  reason: string
  instanceName: string
}

interface StatusPayload {
  instances: Array<{
    name: string
    port: number
    models: Array<string>
    healthy: boolean
    requestCounts: Record<string, number>
  }>
  sessionBindings: Record<string, number>
  modelToPorts: Record<string, Array<number>>
  routeHistorySize: number
}

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

function getHeaderValue(req: Request, name: string): string {
  const value = req.headers.get(name)?.trim()
  return value || "_"
}

function getBindingKey(
  sessionId: string | null,
  agent: string,
  model: string,
): string | null {
  return sessionId ? `${sessionId}:${agent}:${model}` : null
}

function writeSse(
  controller: ReadableStreamDefaultController<Uint8Array>,
  payload: string,
) {
  controller.enqueue(encoder.encode(payload))
}

function broadcastSse(payload: string) {
  for (const controller of sseClients) {
    try {
      writeSse(controller, payload)
    } catch {
      sseClients.delete(controller)
    }
  }
}

const rawInstances: unknown = JSON.parse(readFileSync(TOKENS_PATH, "utf8"))
const instances = parseInstances(rawInstances)
const portToInstance = new Map(
  instances.map((instance) => [instance.port, instance]),
)
const portToModels = new Map<number, Array<string>>()
const modelToPorts = new Map<string, Array<number>>()
const sessionBindings = new Map<string, number>()
const routeHistory: Array<RouteRecord> = []
const sseClients = new Set<ReadableStreamDefaultController<Uint8Array>>()
const portModelCounts = new Map<number, Map<string, number>>()
let globalRoundRobin = 0

function getStatusPayload(): StatusPayload {
  return {
    instances: instances.map((instance) => {
      const modelCounts = portModelCounts.get(instance.port)
      const requestCounts: Record<string, number> =
        modelCounts ? Object.fromEntries(modelCounts) : {}
      return {
        name: instance.name,
        port: instance.port,
        models: portToModels.get(instance.port) || [],
        healthy: portToModels.has(instance.port),
        requestCounts,
      }
    }),
    sessionBindings: Object.fromEntries(sessionBindings),
    modelToPorts: Object.fromEntries(modelToPorts),
    routeHistorySize: routeHistory.length,
  }
}

function incrementCount(port: number, model: string) {
  const modelCounts = portModelCounts.get(port) || new Map<string, number>()
  modelCounts.set(model, (modelCounts.get(model) || 0) + 1)
  portModelCounts.set(port, modelCounts)
}

function recordRoute(record: RouteRecord) {
  routeHistory.push(record)
  if (routeHistory.length > HISTORY_LIMIT) {
    routeHistory.splice(0, routeHistory.length - HISTORY_LIMIT)
  }
  incrementCount(record.port, record.model)
  broadcastSse(`data: ${JSON.stringify(record)}\n\n`)
}

function clearRouteHistory() {
  routeHistory.splice(0)
  broadcastSse(
    `event: reset\ndata: ${JSON.stringify({ target: "history" })}\n\n`,
  )
}

function clearSessionBindings() {
  sessionBindings.clear()
  broadcastSse(
    `event: reset\ndata: ${JSON.stringify({ target: "bindings" })}\n\n`,
  )
}

function createSseResponse(req: Request): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      sseClients.add(controller)
      writeSse(controller, `retry: ${SSE_RETRY_MS}\n\n`)

      const cleanup = () => {
        sseClients.delete(controller)
      }

      req.signal.addEventListener("abort", cleanup, { once: true })
    },
    cancel() {
      return
    },
  })

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "Access-Control-Allow-Origin": "*",
    },
  })
}

async function discoverModels() {
  portToModels.clear()
  modelToPorts.clear()

  for (const inst of instances) {
    try {
      const res = await fetch(`http://localhost:${inst.port}/v1/models`)
      const data: unknown = await res.json()
      const models = parseModelIds(data)
      portToModels.set(inst.port, models)
      for (const model of models) {
        const ports = modelToPorts.get(model) || []
        ports.push(inst.port)
        modelToPorts.set(model, ports)
      }
      log(
        `discovered ${inst.name}:${inst.port} → ${models.length} models: ${models.join(", ")}`,
      )
    } catch (error) {
      log(`FAILED to discover ${inst.name}:${inst.port}: ${formatError(error)}`)
    }
  }

  log(
    `total: ${modelToPorts.size} unique models across ${portToModels.size} instances`,
  )
}

function pickPort(
  sessionId: string | null,
  agent: string,
  model: string,
): { port: number; reason: string; bindingKey: string | null } | null {
  const ports = modelToPorts.get(model)
  if (!ports || ports.length === 0) {
    return null
  }

  const bindingKey = getBindingKey(sessionId, agent, model)

  if (bindingKey) {
    const bound = sessionBindings.get(bindingKey)
    if (bound !== undefined && ports.includes(bound)) {
      return { port: bound, reason: "sticky", bindingKey }
    }
  }

  const port = ports[globalRoundRobin % ports.length]
  globalRoundRobin++

  const hadBinding = bindingKey ? sessionBindings.has(bindingKey) : false
  if (bindingKey) {
    sessionBindings.set(bindingKey, port)
  }

  return { port, reason: hadBinding ? "rebalance" : "new", bindingKey }
}

function getInstanceName(port: number): string {
  return portToInstance.get(port)?.name || `:${port}`
}

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

    return new Response(upstream.body, {
      status: upstream.status,
      headers: upstream.headers,
    })
  } catch (error) {
    log(`PROXY ERROR → :${port}: ${formatError(error)}`)
    return Response.json(
      { error: `upstream connection failed on port ${port}` },
      { status: 502 },
    )
  }
}

await discoverModels()

Bun.serve({
  idleTimeout: 0,
  port: ROUTER_PORT,
  async fetch(req) {
    const url = new URL(req.url)

    if (url.pathname === "/status" && req.method === "GET") {
      return Response.json(getStatusPayload())
    }

    if (url.pathname === "/v1/models" && req.method === "GET") {
      const allModels = new Set<string>()
      for (const models of portToModels.values()) {
        for (const model of models) {
          allModels.add(model)
        }
      }

      return Response.json({
        object: "list",
        data: [...allModels].map((id) => ({ id, object: "model" })),
      })
    }

    const bodyText = await req.text()
    const sessionId = req.headers.get("x-session-id")
    const agent = getHeaderValue(req, "x-oc-agent")
    const provider = getHeaderValue(req, "x-oc-provider")
    const headerModel = getHeaderValue(req, "x-oc-model")
    const model =
      parseModelFromBody(bodyText) || (headerModel === "_" ? "" : headerModel)

    if (!model) {
      const allPorts = instances.map((instance) => instance.port)
      const port = allPorts[globalRoundRobin % allPorts.length]
      globalRoundRobin++
      const instanceName = getInstanceName(port)
      const routeRecord: RouteRecord = {
        ts: new Date().toISOString(),
        sid: sessionId || "-",
        agent,
        model: "_",
        provider,
        port,
        reason: "nomodel",
        instanceName,
      }
      recordRoute(routeRecord)
      log(
        `sid=${routeRecord.sid} agent=${agent} provider=${provider} → ${instanceName}:${port} model=(none) reason=nomodel`,
      )
      return proxyTo(port, { body: bodyText, req, url })
    }

    const result = pickPort(sessionId, agent, model)
    if (!result) {
      log(
        `NO PORT sid=${sessionId || "-"} agent=${agent} model=${model} provider=${provider}`,
      )
      return Response.json(
        { error: `no instance serves model: ${model}` },
        { status: 502 },
      )
    }

    const instanceName = getInstanceName(result.port)
    const routeRecord: RouteRecord = {
      ts: new Date().toISOString(),
      sid: sessionId || "-",
      agent,
      model,
      provider,
      port: result.port,
      reason: result.reason,
      instanceName,
    }
    recordRoute(routeRecord)
    log(
      `sid=${routeRecord.sid} agent=${agent} provider=${provider} → ${instanceName}:${result.port} model=${model} reason=${result.reason}`,
    )
    return proxyTo(result.port, { body: bodyText, req, url })
  },
})

Bun.serve({
  idleTimeout: 0,
  port: DASHBOARD_PORT,
  async fetch(req) {
    const url = new URL(req.url)

    if (
      (url.pathname === "/" || url.pathname === "/index.html")
      && req.method === "GET"
    ) {
      if (!(await DASHBOARD_FILE.exists())) {
        return new Response("dashboard.html not found", { status: 404 })
      }
      return new Response(DASHBOARD_FILE, {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      })
    }

    if (url.pathname === "/api/status" && req.method === "GET") {
      return Response.json(getStatusPayload())
    }

    if (url.pathname === "/api/history" && req.method === "GET") {
      return Response.json(routeHistory)
    }

    if (url.pathname === "/api/history/clear" && req.method === "POST") {
      const cleared = routeHistory.length
      clearRouteHistory()
      log(`dashboard cleared route history count=${cleared}`)
      return Response.json({ ok: true, cleared })
    }

    if (url.pathname === "/api/bindings/clear" && req.method === "POST") {
      const cleared = sessionBindings.size
      clearSessionBindings()
      log(`dashboard cleared active bindings count=${cleared}`)
      return Response.json({ ok: true, cleared })
    }

    if (url.pathname === "/api/events" && req.method === "GET") {
      return createSseResponse(req)
    }

    return new Response("Not found", { status: 404 })
  },
})

log(
  `router started on :${ROUTER_PORT}, ${instances.length} instances: ${instances.map((instance) => `${instance.name}:${instance.port}`).join(", ")}`,
)
console.log(
  `\n  Sticky router listening on http://localhost:${ROUTER_PORT}\n  Dashboard listening on http://localhost:${DASHBOARD_PORT}\n`,
)
