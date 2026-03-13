import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  createDashboardHandler,
  createRouterHandler,
  createStickyRouterState,
} from "../../router/state"

function createFetchStub(
  handler: (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ) => Promise<Response>,
): typeof fetch {
  return Object.assign(handler, { preconnect: fetch.preconnect })
}

function toInputUrl(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === "string") {
    return input
  }

  if (input instanceof URL) {
    return input.toString()
  }

  return input.url
}

async function createDashboardPath(): Promise<string> {
  const dashboardPath = join(
    tmpdir(),
    `sticky-router-dashboard-${crypto.randomUUID()}.html`,
  )
  await Bun.write(dashboardPath, "<html><body>dashboard</body></html>")
  return dashboardPath
}

function removeDashboardPath(dashboardPath: string) {
  if (dashboardPath) {
    rmSync(dashboardPath, { force: true })
  }
}

function createState() {
  return createStickyRouterState([
    { name: "alpha", port: 4141 },
    { name: "beta", port: 4142 },
  ])
}

describe("router handlers", () => {
  test("router handler serves status and model catalog", async () => {
    const state = createState()
    state.portToModels.set(4141, ["gpt-4.1"])
    state.portToModels.set(4142, ["gpt-4.1", "claude-3.7"])
    state.modelToPorts.set("gpt-4.1", [4141, 4142])
    state.modelToPorts.set("claude-3.7", [4142])

    const handler = createRouterHandler({ state, logger: () => {} })

    const statusRes = await handler(new Request("http://localhost/status"))
    const modelsRes = await handler(new Request("http://localhost/v1/models"))

    expect(await statusRes.json()).toEqual({
      instances: [
        {
          name: "alpha",
          port: 4141,
          models: ["gpt-4.1"],
          healthy: true,
          requestCounts: {},
        },
        {
          name: "beta",
          port: 4142,
          models: ["gpt-4.1", "claude-3.7"],
          healthy: true,
          requestCounts: {},
        },
      ],
      sessionBindings: {},
      modelToPorts: {
        "gpt-4.1": [4141, 4142],
        "claude-3.7": [4142],
      },
      routeHistorySize: 0,
    })

    const modelsPayload = await modelsRes.json()
    expect(modelsPayload).toEqual({
      object: "list",
      data: [
        { id: "gpt-4.1", object: "model" },
        { id: "claude-3.7", object: "model" },
      ],
    })
  })

  test("router handler preserves sticky routing for repeated session requests", async () => {
    const state = createState()
    const logs: Array<string> = []
    const proxiedPorts: Array<string> = []
    state.modelToPorts.set("gpt-4.1", [4141, 4142])

    const fetchImpl = createFetchStub((input) => {
      proxiedPorts.push(new URL(toInputUrl(input)).port)
      return Promise.resolve(new Response("ok"))
    })

    const handler = createRouterHandler({
      state,
      logger: (line) => logs.push(line),
      fetchImpl,
      now: () => "2026-03-13T00:00:00.000Z",
    })

    const first = await handler(
      new Request("http://localhost/v1/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-session-id": "session-1",
          "x-oc-agent": "atlas",
          "x-oc-provider": "openai",
        },
        body: '{"model":"gpt-4.1"}',
      }),
    )
    const second = await handler(
      new Request("http://localhost/v1/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-session-id": "session-1",
          "x-oc-agent": "atlas",
          "x-oc-provider": "openai",
        },
        body: '{"model":"gpt-4.1"}',
      }),
    )

    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    expect(proxiedPorts[0]).toBe(proxiedPorts[1])
    expect(state.routeHistory.map((entry) => entry.reason)).toEqual([
      "new",
      "sticky",
    ])
    expect(logs[0]).toContain("reason=new")
    expect(logs[1]).toContain("reason=sticky")
  })

  test("router handler distributes nomodel requests by least-loaded and rejects unknown models", async () => {
    const state = createState()
    const proxiedPorts: Array<string> = []

    const fetchImpl = createFetchStub((input) => {
      proxiedPorts.push(new URL(toInputUrl(input)).port)
      return Promise.resolve(new Response("ok"))
    })

    const handler = createRouterHandler({
      state,
      logger: () => {},
      fetchImpl,
      now: () => "2026-03-13T00:00:00.000Z",
    })

    const first = await handler(
      new Request("http://localhost/v1/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-oc-agent": "atlas",
          "x-oc-provider": "openai",
        },
        body: '{"messages":[]}',
      }),
    )
    const second = await handler(
      new Request("http://localhost/v1/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-oc-agent": "atlas",
          "x-oc-provider": "openai",
        },
        body: '{"messages":[]}',
      }),
    )

    state.modelToPorts.clear()

    const unknown = await handler(
      new Request("http://localhost/v1/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-oc-agent": "atlas",
          "x-oc-provider": "openai",
        },
        body: '{"model":"does-not-exist"}',
      }),
    )

    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    expect(proxiedPorts.sort()).toEqual(["4141", "4142"])
    expect(state.routeHistory.slice(0, 2).map((entry) => entry.reason)).toEqual(
      ["nomodel", "nomodel"],
    )
    expect(unknown.status).toBe(502)
    expect(await unknown.json()).toEqual({
      error: "no instance serves model: does-not-exist",
    })
  })
})

describe("dashboard handler", () => {
  let dashboardPath = ""

  beforeEach(async () => {
    dashboardPath = await createDashboardPath()
  })

  afterEach(() => {
    removeDashboardPath(dashboardPath)
  })

  test("dashboard handler serves html, clears state, and opens an SSE stream", async () => {
    const state = createState()
    const logs: Array<string> = []
    state.routeHistory.push({
      ts: "2026-03-13T00:00:00.000Z",
      sid: "session-1",
      agent: "atlas",
      model: "gpt-4.1",
      provider: "openai",
      port: 4141,
      reason: "new",
      instanceName: "alpha",
    })
    state.sessionBindings.set("session-1:atlas:gpt-4.1", 4141)

    const handler = createDashboardHandler({
      state,
      logger: (line) => logs.push(line),
      dashboardFile: Bun.file(dashboardPath),
    })

    const html = await handler(new Request("http://localhost/"))
    const clearHistory = await handler(
      new Request("http://localhost/api/history/clear", { method: "POST" }),
    )
    const clearBindings = await handler(
      new Request("http://localhost/api/bindings/clear", { method: "POST" }),
    )

    const abortController = new AbortController()
    const events = await handler(
      new Request("http://localhost/api/events", {
        signal: abortController.signal,
      }),
    )
    const reader = events.body?.getReader()
    const firstChunk = reader ? await reader.read() : null
    abortController.abort()
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(html.status).toBe(200)
    expect(html.headers.get("content-type")).toBe("text/html; charset=utf-8")
    expect(await html.text()).toContain("dashboard")
    expect(await clearHistory.json()).toEqual({ ok: true, cleared: 1 })
    expect(await clearBindings.json()).toEqual({ ok: true, cleared: 1 })
    expect(state.routeHistory).toEqual([])
    expect(state.sessionBindings.size).toBe(0)
    expect(events.headers.get("content-type")).toBe("text/event-stream")
    const firstChunkValue =
      firstChunk && firstChunk.value instanceof Uint8Array ?
        firstChunk.value
      : undefined

    expect(new TextDecoder().decode(firstChunkValue)).toContain("retry: 2000")
    expect(state.sseClients.size).toBe(0)
    expect(logs).toEqual([
      "dashboard cleared route history count=1",
      "dashboard cleared active bindings count=1",
    ])
  })
})
