import { describe, expect, test } from "bun:test"

import {
  createDashboardHandler,
  createStickyRouterState,
  getAvailablePorts,
  getStatusPayload,
  pickPort,
} from "../../router/state"

const INSTANCES = [
  { name: "alpha", port: 4141 },
  { name: "beta", port: 4142 },
  { name: "gamma", port: 4143 },
]

function createState() {
  return createStickyRouterState(INSTANCES)
}

const dashboardFile = Bun.file(
  new URL("../../router/dashboard.html", import.meta.url),
)

function makeHandler(state: ReturnType<typeof createStickyRouterState>) {
  return createDashboardHandler({
    state,
    logger: () => {},
    dashboardFile,
  })
}

describe("instance toggle invariants", () => {
  test("1. all instances are enabled by default", () => {
    const state = createState()
    const payload = getStatusPayload(state)

    expect(state.disabledPorts.size).toBe(0)
    for (const instance of payload.instances) {
      expect(instance.disabled).toBe(false)
    }
  })

  test("2. disabled port is skipped by getAvailablePorts and pickPort", () => {
    const state = createState()
    state.disabledPorts.add(4142)
    state.modelToPorts.set("gpt-4.1", [4141, 4142, 4143])

    const nowMs = Date.now()
    const available = getAvailablePorts(state, [4141, 4142, 4143], nowMs)

    expect(available).not.toContain(4142)
    expect(available.sort()).toEqual([4141, 4143])

    // Actually run pickPort many times — 4142 must never be selected
    const picked = new Set<number>()
    for (let i = 0; i < 100; i++) {
      const fresh = createState()
      fresh.disabledPorts.add(4142)
      fresh.modelToPorts.set("gpt-4.1", [4141, 4142, 4143])
      const result = pickPort(fresh, {
        sessionId: null,
        agent: "atlas",
        model: "gpt-4.1",
      })
      if (result) picked.add(result.port)
    }
    expect(picked.has(4142)).toBe(false)
    expect(picked.size).toBeGreaterThanOrEqual(1)
  })

  test("3. re-enabling a port restores it to the candidate pool", () => {
    const state = createState()
    state.modelToPorts.set("gpt-4.1", [4141, 4142, 4143])

    state.disabledPorts.add(4142)
    const before = getAvailablePorts(state, [4141, 4142, 4143], Date.now())
    expect(before).not.toContain(4142)

    state.disabledPorts.delete(4142)
    const after = getAvailablePorts(state, [4141, 4142, 4143], Date.now())
    expect(after).toContain(4142)
    expect(after.sort()).toEqual([4141, 4142, 4143])

    // pickPort can now return 4142 again
    const picked = new Set<number>()
    for (let i = 0; i < 100; i++) {
      const result = pickPort(state, {
        sessionId: null,
        agent: "atlas",
        model: "gpt-4.1",
      })
      if (result) picked.add(result.port)
    }
    expect(picked.has(4142)).toBe(true)
  })

  test("4. disabled and cooldown are independent", () => {
    const state = createState()
    const nowMs = Date.now()

    // Set cooldown on 4141, then disable it — cooldownUntil must remain
    state.portCooldownUntil.set(4141, nowMs + 60_000)
    state.disabledPorts.add(4141)
    expect(state.disabledPorts.has(4141)).toBe(true)
    expect(state.portCooldownUntil.get(4141)).toBe(nowMs + 60_000)

    // payload reflects both independently
    const payload = getStatusPayload(state, nowMs)
    const instance = payload.instances.find((i) => i.port === 4141)!
    expect(instance.disabled).toBe(true)
    expect(instance.cooldownUntil).toBeTruthy()
    expect(instance.remainingCooldownMs).toBeGreaterThan(0)

    // Un-disabling does NOT clear cooldown
    state.disabledPorts.delete(4141)
    expect(state.disabledPorts.has(4141)).toBe(false)
    expect(state.portCooldownUntil.get(4141)).toBe(nowMs + 60_000)

    // Conversely: clearing cooldown does NOT re-enable
    state.disabledPorts.add(4141)
    state.portCooldownUntil.delete(4141)
    expect(state.disabledPorts.has(4141)).toBe(true)
    expect(state.portCooldownUntil.has(4141)).toBe(false)

    // getAvailablePorts still excludes 4141 because disabled alone is enough
    const available = getAvailablePorts(state, [4141, 4142, 4143], nowMs)
    expect(available).not.toContain(4141)
  })

  test("5. PATCH unknown port returns 404", async () => {
    const state = createState()
    const handler = makeHandler(state)

    const res = await handler(
      new Request("http://localhost/api/instances/99999", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ disabled: true }),
      }),
    )
    expect(res.status).toBe(404)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.error).toBeDefined()
  })

  test("6. PATCH triggers SSE broadcast to connected clients", async () => {
    const state = createState()
    state.modelToPorts.set("gpt-4.1", [4141, 4142, 4143])
    const handler = makeHandler(state)

    // Connect SSE client — get the streaming response
    const sseAbort = new AbortController()
    const sseResponse = await handler(
      new Request("http://localhost/api/events", {
        signal: sseAbort.signal,
      }),
    )
    expect(sseResponse.status).toBe(200)
    expect(sseResponse.headers.get("content-type")).toBe("text/event-stream")

    // Confirm SSE client was registered in state
    expect(state.sseClients.size).toBe(1)

    const reader =
      sseResponse.body!.getReader() as ReadableStreamDefaultReader<Uint8Array>
    const decoder = new TextDecoder()

    // Drain the initial retry frame
    const initial = await reader.read()
    const initialText = decoder.decode(initial.value)
    expect(initialText).toContain("retry:")

    // Fire PATCH — this must broadcast to the SSE stream
    const patchRes = await handler(
      new Request("http://localhost/api/instances/4141", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ disabled: true }),
      }),
    )
    expect(patchRes.status).toBe(200)
    const patchBody = (await patchRes.json()) as Record<string, unknown>
    expect(patchBody).toEqual({ ok: true, port: 4141, disabled: true })

    // Read the SSE broadcast — wait up to 2s
    const deadline = Date.now() + 2000
    let found = false
    while (Date.now() < deadline) {
      const { value, done } = await reader.read()
      if (done) break
      const text = decoder.decode(value)
      if (
        text.includes("event: reset")
        && text.includes('"target":"instances"')
      ) {
        found = true
        break
      }
    }

    sseAbort.abort()
    expect(found).toBe(true)

    // State was actually mutated
    expect(state.disabledPorts.has(4141)).toBe(true)
  })
})
