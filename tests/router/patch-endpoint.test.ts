import { describe, expect, test } from "bun:test"
import {
  createDashboardHandler,
  createStickyRouterState,
  setInstanceDisabled,
} from "../../router/state"

function createState() {
  return createStickyRouterState([
    { name: "alpha", port: 4141 },
    { name: "beta", port: 4142 },
  ])
}

const dashboardFile = Bun.file(
  new URL("../../router/dashboard.html", import.meta.url),
)

function handler(
  state: ReturnType<typeof createStickyRouterState>,
  fetchImpl?: typeof fetch,
) {
  return createDashboardHandler({
    state,
    logger: () => {},
    dashboardFile,
    fetchImpl,
  })
}

describe("PATCH /api/instances/:port", () => {
  test("disabling a known port updates state.disabledPorts", async () => {
    const state = createState()
    const handle = handler(state)

    const response = await handle(
      new Request("http://localhost/api/instances/4141", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ disabled: true }),
      }),
    )

    expect(response.status).toBe(200)
    const payload = await response.json()
    expect(payload).toEqual({ ok: true, port: 4141, disabled: true })
    expect(state.disabledPorts.has(4141)).toBe(true)

    // re-enabling should clear it
    const reenable = await handle(
      new Request("http://localhost/api/instances/4141", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ disabled: false }),
      }),
    )
    expect(reenable.status).toBe(200)
    expect(state.disabledPorts.has(4141)).toBe(false)
  })

  test("unknown port returns 404", async () => {
    const state = createState()
    const handle = handler(state)

    const response = await handle(
      new Request("http://localhost/api/instances/9999", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ disabled: true }),
      }),
    )

    expect(response.status).toBe(404)
    const payload = await response.json()
    expect(payload).toHaveProperty("error")
  })

  test("wrong method returns 405", async () => {
    const state = createState()
    const handle = handler(state)

    const response = await handle(
      new Request("http://localhost/api/instances/4141", {
        method: "POST",
      }),
    )

    expect(response.status).toBe(405)
    expect(response.headers.get("allow")).toBe("PATCH")
  })

  test("missing disabled field returns 400", async () => {
    const state = createState()
    const handle = handler(state)

    const response = await handle(
      new Request("http://localhost/api/instances/4141", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      }),
    )

    expect(response.status).toBe(400)
  })
})

describe("setInstanceDisabled broadcasts SSE reset", () => {
  test("broadcasts to SSE clients", () => {
    const state = createState()
    const encoder = new TextEncoder()

    // Set up a mock SSE client
    const receivedChunks: string[] = []
    const fakeController = {
      enqueue(chunk: Uint8Array) {
        receivedChunks.push(new TextDecoder().decode(chunk))
      },
      close() {},
      error() {},
      desiredSize: 1,
    } as unknown as ReadableStreamDefaultController<Uint8Array>
    state.sseClients.add(fakeController)

    setInstanceDisabled(state, 4141, true, encoder)

    expect(state.disabledPorts.has(4141)).toBe(true)
    expect(receivedChunks.length).toBe(1)
    expect(receivedChunks[0]).toContain("event: reset")
    expect(receivedChunks[0]).toContain('"target":"instances"')

    state.sseClients.delete(fakeController)
  })
})

describe("POST /api/usage/refresh", () => {
  test("refreshes premium usage for every instance without proxy requests", async () => {
    const state = createState()
    const requestedUrls: Array<string> = []
    const fetchImpl = ((input: Parameters<typeof fetch>[0]) => {
      const url =
        typeof input === "string" ? input
        : input instanceof Request ? input.url
        : input.href
      requestedUrls.push(url)
      const port = new URL(url).port
      return Promise.resolve(
        new Response(
          JSON.stringify({
            quota_snapshots: {
              premium_interactions: {
                entitlement: port === "4141" ? 300 : 500,
                credits_used: port === "4141" ? 120 : 250,
                overage_count: 0,
                percent_remaining: 0,
              },
            },
          }),
          { headers: { "content-type": "application/json" } },
        ),
      )
    }) as typeof fetch
    const handle = handler(state, fetchImpl)

    const response = await handle(
      new Request("http://localhost/api/usage/refresh", { method: "POST" }),
    )

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true })
    expect(requestedUrls).toEqual([
      "http://localhost:4141/usage",
      "http://localhost:4142/usage",
    ])
    expect(state.portHeaderSnapshots.get(4141)?.premiumUsage).toEqual({
      used: 120,
      total: 300,
    })
    expect(state.portHeaderSnapshots.get(4142)?.premiumUsage).toEqual({
      used: 250,
      total: 500,
    })
  })
})
