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

function handler(state: ReturnType<typeof createStickyRouterState>) {
  return createDashboardHandler({
    state,
    logger: () => {},
    dashboardFile,
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
