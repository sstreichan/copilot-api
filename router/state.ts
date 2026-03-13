import type { Instance } from "./lib"

import {
  formatError,
  getBindingKey,
  getHeaderValue,
  parseModelFromBody,
  parseModelIds,
} from "./lib"

const DEFAULT_ENCODER = new TextEncoder()

export const DEFAULT_HISTORY_LIMIT = 200
export const DEFAULT_SSE_RETRY_MS = 2000

export interface ProxyContext {
  body: string
  req: Request
  url: URL
}

export interface RouteRecord {
  ts: string
  sid: string
  agent: string
  model: string
  provider: string
  port: number
  reason: string
  instanceName: string
}

export interface StatusPayload {
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

export interface StickyRouterState {
  instances: Array<Instance>
  portToInstance: Map<number, Instance>
  portToModels: Map<number, Array<string>>
  modelToPorts: Map<string, Array<number>>
  sessionBindings: Map<string, number>
  routeHistory: Array<RouteRecord>
  sseClients: Set<ReadableStreamDefaultController<Uint8Array>>
  portModelCounts: Map<number, Map<string, number>>
  globalRoundRobin: number
}

export interface RouterHandlerOptions {
  state: StickyRouterState
  logger: (line: string) => void
  fetchImpl?: typeof fetch
  now?: () => string
}

export interface PortSelectionInput {
  sessionId: string | null
  agent: string
  model: string
}

export interface ProxyToOptions {
  port: number
  context: ProxyContext
  logger: (line: string) => void
  fetchImpl?: typeof fetch
}

export interface DashboardHandlerOptions {
  state: StickyRouterState
  logger: (line: string) => void
  dashboardFile: Bun.BunFile
  encoder?: TextEncoder
  sseRetryMs?: number
}

export function createStickyRouterState(
  instances: Array<Instance>,
): StickyRouterState {
  return {
    instances,
    portToInstance: new Map(
      instances.map((instance) => [instance.port, instance]),
    ),
    portToModels: new Map<number, Array<string>>(),
    modelToPorts: new Map<string, Array<number>>(),
    sessionBindings: new Map<string, number>(),
    routeHistory: [],
    sseClients: new Set<ReadableStreamDefaultController<Uint8Array>>(),
    portModelCounts: new Map<number, Map<string, number>>(),
    globalRoundRobin: 0,
  }
}

export function getStatusPayload(state: StickyRouterState): StatusPayload {
  return {
    instances: state.instances.map((instance) => {
      const modelCounts = state.portModelCounts.get(instance.port)
      const requestCounts: Record<string, number> =
        modelCounts ? Object.fromEntries(modelCounts) : {}
      return {
        name: instance.name,
        port: instance.port,
        models: state.portToModels.get(instance.port) || [],
        healthy: state.portToModels.has(instance.port),
        requestCounts,
      }
    }),
    sessionBindings: Object.fromEntries(state.sessionBindings),
    modelToPorts: Object.fromEntries(state.modelToPorts),
    routeHistorySize: state.routeHistory.length,
  }
}

export function incrementCount(
  state: StickyRouterState,
  port: number,
  model: string,
) {
  const modelCounts =
    state.portModelCounts.get(port) || new Map<string, number>()
  modelCounts.set(model, (modelCounts.get(model) || 0) + 1)
  state.portModelCounts.set(port, modelCounts)
}

export function writeSse(
  controller: ReadableStreamDefaultController<Uint8Array>,
  payload: string,
  encoder = DEFAULT_ENCODER,
) {
  controller.enqueue(encoder.encode(payload))
}

export function broadcastSse(
  state: StickyRouterState,
  payload: string,
  encoder = DEFAULT_ENCODER,
) {
  for (const controller of state.sseClients) {
    try {
      writeSse(controller, payload, encoder)
    } catch {
      state.sseClients.delete(controller)
    }
  }
}

export function recordRoute(
  state: StickyRouterState,
  record: RouteRecord,
  options: { historyLimit?: number; encoder?: TextEncoder } = {},
) {
  const historyLimit = options.historyLimit ?? DEFAULT_HISTORY_LIMIT
  const encoder = options.encoder ?? DEFAULT_ENCODER

  state.routeHistory.push(record)
  if (state.routeHistory.length > historyLimit) {
    state.routeHistory.splice(0, state.routeHistory.length - historyLimit)
  }
  incrementCount(state, record.port, record.model)
  broadcastSse(state, `data: ${JSON.stringify(record)}\n\n`, encoder)
}

export function clearRouteHistory(
  state: StickyRouterState,
  encoder = DEFAULT_ENCODER,
) {
  state.routeHistory.splice(0)
  broadcastSse(
    state,
    `event: reset\ndata: ${JSON.stringify({ target: "history" })}\n\n`,
    encoder,
  )
}

export function clearSessionBindings(
  state: StickyRouterState,
  encoder = DEFAULT_ENCODER,
) {
  state.sessionBindings.clear()
  broadcastSse(
    state,
    `event: reset\ndata: ${JSON.stringify({ target: "bindings" })}\n\n`,
    encoder,
  )
}

export function createSseResponse(
  state: StickyRouterState,
  req: Request,
  options: { encoder?: TextEncoder; sseRetryMs?: number } = {},
): Response {
  const encoder = options.encoder ?? DEFAULT_ENCODER
  const sseRetryMs = options.sseRetryMs ?? DEFAULT_SSE_RETRY_MS

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      state.sseClients.add(controller)
      writeSse(controller, `retry: ${sseRetryMs}\n\n`, encoder)

      const cleanup = () => {
        state.sseClients.delete(controller)
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

export async function discoverModels(
  state: StickyRouterState,
  logger: (line: string) => void,
  fetchImpl: typeof fetch = fetch,
) {
  state.portToModels.clear()
  state.modelToPorts.clear()

  for (const inst of state.instances) {
    try {
      const res = await fetchImpl(`http://localhost:${inst.port}/v1/models`)
      const data: unknown = await res.json()
      const models = parseModelIds(data)
      state.portToModels.set(inst.port, models)
      for (const model of models) {
        const ports = state.modelToPorts.get(model) || []
        ports.push(inst.port)
        state.modelToPorts.set(model, ports)
      }
      logger(
        `discovered ${inst.name}:${inst.port} → ${models.length} models: ${models.join(", ")}`,
      )
    } catch (error) {
      logger(
        `FAILED to discover ${inst.name}:${inst.port}: ${formatError(error)}`,
      )
    }
  }

  logger(
    `total: ${state.modelToPorts.size} unique models across ${state.portToModels.size} instances`,
  )
}

export function pickPort(
  state: StickyRouterState,
  input: PortSelectionInput,
): { port: number; reason: string; bindingKey: string | null } | null {
  const { sessionId, agent, model } = input
  const ports = state.modelToPorts.get(model)
  if (!ports || ports.length === 0) {
    return null
  }

  const bindingKey = getBindingKey(sessionId, agent, model)

  if (bindingKey) {
    const bound = state.sessionBindings.get(bindingKey)
    if (bound !== undefined && ports.includes(bound)) {
      return { port: bound, reason: "sticky", bindingKey }
    }
  }

  const port = ports[state.globalRoundRobin % ports.length]
  state.globalRoundRobin++

  const hadBinding = bindingKey ? state.sessionBindings.has(bindingKey) : false
  if (bindingKey) {
    state.sessionBindings.set(bindingKey, port)
  }

  return { port, reason: hadBinding ? "rebalance" : "new", bindingKey }
}

export function getInstanceName(
  state: StickyRouterState,
  port: number,
): string {
  return state.portToInstance.get(port)?.name || `:${port}`
}

export async function proxyTo(options: ProxyToOptions): Promise<Response> {
  const { port, context, logger } = options
  const fetchImpl = options.fetchImpl ?? fetch
  const { body, req, url } = context
  const targetUrl = `http://localhost:${port}${url.pathname}${url.search}`
  const headers = new Headers(req.headers)
  headers.delete("host")

  try {
    const upstream = await fetchImpl(targetUrl, {
      method: req.method,
      headers,
      body: req.method !== "GET" && req.method !== "HEAD" ? body : undefined,
    })

    return new Response(upstream.body, {
      status: upstream.status,
      headers: upstream.headers,
    })
  } catch (error) {
    logger(`PROXY ERROR → :${port}: ${formatError(error)}`)
    return Response.json(
      { error: `upstream connection failed on port ${port}` },
      { status: 502 },
    )
  }
}

export function createRouterHandler(options: RouterHandlerOptions) {
  const fetchImpl = options.fetchImpl ?? fetch
  const now = options.now ?? (() => new Date().toISOString())

  return async function handleRouterRequest(req: Request): Promise<Response> {
    const url = new URL(req.url)

    if (url.pathname === "/status" && req.method === "GET") {
      return Response.json(getStatusPayload(options.state))
    }

    if (url.pathname === "/v1/models" && req.method === "GET") {
      const allModels = new Set<string>()
      for (const models of options.state.portToModels.values()) {
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
      const allPorts = options.state.instances.map((instance) => instance.port)
      const port = allPorts[options.state.globalRoundRobin % allPorts.length]
      options.state.globalRoundRobin++
      const instanceName = getInstanceName(options.state, port)
      const routeRecord: RouteRecord = {
        ts: now(),
        sid: sessionId || "-",
        agent,
        model: "_",
        provider,
        port,
        reason: "nomodel",
        instanceName,
      }
      recordRoute(options.state, routeRecord)
      options.logger(
        `sid=${routeRecord.sid} agent=${agent} provider=${provider} → ${instanceName}:${port} model=(none) reason=nomodel`,
      )
      return proxyTo({
        port,
        context: { body: bodyText, req, url },
        logger: options.logger,
        fetchImpl,
      })
    }

    const result = pickPort(options.state, { sessionId, agent, model })
    if (!result) {
      options.logger(
        `NO PORT sid=${sessionId || "-"} agent=${agent} model=${model} provider=${provider}`,
      )
      return Response.json(
        { error: `no instance serves model: ${model}` },
        { status: 502 },
      )
    }

    const instanceName = getInstanceName(options.state, result.port)
    const routeRecord: RouteRecord = {
      ts: now(),
      sid: sessionId || "-",
      agent,
      model,
      provider,
      port: result.port,
      reason: result.reason,
      instanceName,
    }
    recordRoute(options.state, routeRecord)
    options.logger(
      `sid=${routeRecord.sid} agent=${agent} provider=${provider} → ${instanceName}:${result.port} model=${model} reason=${result.reason}`,
    )
    return proxyTo({
      port: result.port,
      context: { body: bodyText, req, url },
      logger: options.logger,
      fetchImpl,
    })
  }
}

export function createDashboardHandler(options: DashboardHandlerOptions) {
  const encoder = options.encoder ?? DEFAULT_ENCODER
  const sseRetryMs = options.sseRetryMs ?? DEFAULT_SSE_RETRY_MS

  return async function handleDashboardRequest(
    req: Request,
  ): Promise<Response> {
    const url = new URL(req.url)

    if (
      (url.pathname === "/" || url.pathname === "/index.html")
      && req.method === "GET"
    ) {
      if (!(await options.dashboardFile.exists())) {
        return new Response("dashboard.html not found", { status: 404 })
      }
      return new Response(options.dashboardFile, {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      })
    }

    if (url.pathname === "/api/status" && req.method === "GET") {
      return Response.json(getStatusPayload(options.state))
    }

    if (url.pathname === "/api/history" && req.method === "GET") {
      return Response.json(options.state.routeHistory)
    }

    if (url.pathname === "/api/history/clear" && req.method === "POST") {
      const cleared = options.state.routeHistory.length
      clearRouteHistory(options.state, encoder)
      options.logger(`dashboard cleared route history count=${cleared}`)
      return Response.json({ ok: true, cleared })
    }

    if (url.pathname === "/api/bindings/clear" && req.method === "POST") {
      const cleared = options.state.sessionBindings.size
      clearSessionBindings(options.state, encoder)
      options.logger(`dashboard cleared active bindings count=${cleared}`)
      return Response.json({ ok: true, cleared })
    }

    if (url.pathname === "/api/events" && req.method === "GET") {
      return createSseResponse(options.state, req, { encoder, sseRetryMs })
    }

    return new Response("Not found", { status: 404 })
  }
}
