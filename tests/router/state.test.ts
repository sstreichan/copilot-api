import { describe, expect, test } from "bun:test"

import {
  DEFAULT_HISTORY_LIMIT,
  clearRouteHistory,
  clearSessionBindings,
  createStickyRouterState,
  discoverModels,
  getStatusPayload,
  incrementCount,
  pickPort,
  recordRoute,
} from "../../router/state"

function createState() {
  return createStickyRouterState([
    { name: "alpha", port: 4141 },
    { name: "beta", port: 4142 },
  ])
}

function createDiscoverModelsFetchStub(
  payload: unknown,
): Parameters<typeof discoverModels>[2] {
  const preconnect: typeof fetch.preconnect = (...args) => {
    if (typeof fetch.preconnect === "function") {
      fetch.preconnect(...args)
      return
    }
  }

  return Object.assign(
    () =>
      Promise.resolve(
        new Response(JSON.stringify(payload), {
          headers: { "Content-Type": "application/json" },
        }),
      ),
    {
      preconnect,
    },
  )
}

// eslint-disable-next-line max-lines-per-function
describe("router state helpers", () => {
  test("pickPort selects least-loaded port for new bindings", () => {
    const state = createState()
    state.modelToPorts.set("gpt-4.1", [4141, 4142])

    // Give 4141 more load than 4142
    incrementCount(state, 4141, "gpt-4.1")
    incrementCount(state, 4141, "gpt-4.1")
    incrementCount(state, 4141, "gpt-4.1")
    incrementCount(state, 4142, "gpt-4.1")

    const result = pickPort(state, {
      sessionId: null,
      agent: "atlas",
      model: "gpt-4.1",
    })

    expect(result).toEqual({
      port: 4142,
      reason: "new",
      bindingKey: null,
    })
    expect(state.sessionBindings.size).toBe(0)
  })

  test("pickPort picks randomly among tied least-loaded ports", () => {
    const ports = new Set<number>()

    // Run enough times to observe both ports get picked
    for (let i = 0; i < 50; i++) {
      const state = createState()
      state.modelToPorts.set("gpt-4.1", [4141, 4142])
      const result = pickPort(state, {
        sessionId: null,
        agent: "atlas",
        model: "gpt-4.1",
      })
      if (result) ports.add(result.port)
    }

    // With 50 trials, probability of seeing only one port = 2 * (0.5^50) ≈ 0
    expect(ports.size).toBe(2)
  })

  test("pickPort creates and reuses sticky bindings", () => {
    const state = createState()
    state.modelToPorts.set("gpt-4.1", [4141, 4142])

    const first = pickPort(state, {
      sessionId: "session-1",
      agent: "atlas",
      model: "gpt-4.1",
    })
    const second = pickPort(state, {
      sessionId: "session-1",
      agent: "atlas",
      model: "gpt-4.1",
    })

    // First call: new binding, port is random among least-loaded
    expect(first).toBeDefined()
    if (!first) throw new Error("unreachable")
    expect(first.reason).toBe("new")
    expect(first.bindingKey).toBe("session-1:atlas:gpt-4.1")
    expect([4141, 4142]).toContain(first.port)

    // Second call: sticky - must reuse same port
    expect(second).toEqual({
      port: first.port,
      reason: "sticky",
      bindingKey: "session-1:atlas:gpt-4.1",
    })
  })

  test("pickPort rebalances when an existing binding points to a missing port", () => {
    const state = createState()
    state.sessionBindings.set("session-1:atlas:gpt-4.1", 4141)
    state.modelToPorts.set("gpt-4.1", [4142])

    expect(
      pickPort(state, {
        sessionId: "session-1",
        agent: "atlas",
        model: "gpt-4.1",
      }),
    ).toEqual({
      port: 4142,
      reason: "rebalance",
      bindingKey: "session-1:atlas:gpt-4.1",
    })
    expect(state.sessionBindings.get("session-1:atlas:gpt-4.1")).toBe(4142)
  })

  test("pickPort excludes cooled ports and rebalances sticky binding", () => {
    const state = createState()
    state.modelToPorts.set("gpt-4.1", [4141, 4142])
    state.sessionBindings.set("session-1:atlas:gpt-4.1", 4141)
    state.portCooldownUntil.set(
      4141,
      new Date("2026-03-13T00:01:00.000Z").getTime(),
    )

    const result = pickPort(state, {
      sessionId: "session-1",
      agent: "atlas",
      model: "gpt-4.1",
      nowMs: new Date("2026-03-13T00:00:00.000Z").getTime(),
    })

    expect(result).toEqual({
      port: 4142,
      reason: "rebalance",
      bindingKey: "session-1:atlas:gpt-4.1",
    })
    expect(state.sessionBindings.get("session-1:atlas:gpt-4.1")).toBe(4142)
  })

  test("pickPort returns null when every model candidate is cooling", () => {
    const state = createState()
    state.modelToPorts.set("gpt-4.1", [4141, 4142])
    state.portCooldownUntil.set(
      4141,
      new Date("2026-03-13T00:01:00.000Z").getTime(),
    )
    state.portCooldownUntil.set(
      4142,
      new Date("2026-03-13T00:01:30.000Z").getTime(),
    )

    expect(
      pickPort(state, {
        sessionId: "session-1",
        agent: "atlas",
        model: "gpt-4.1",
        nowMs: new Date("2026-03-13T00:00:00.000Z").getTime(),
      }),
    ).toBeNull()
  })

  test("recordRoute trims history, counts models, and feeds status payload", () => {
    const state = createState()
    state.portToModels.set(4141, ["gpt-4.1"])

    for (let index = 0; index <= DEFAULT_HISTORY_LIMIT; index++) {
      recordRoute(state, {
        ts: `t-${index}`,
        sid: `s-${index}`,
        agent: "atlas",
        model: "gpt-4.1",
        provider: "openai",
        port: 4141,
        reason: "new",
        instanceName: "alpha",
      })
    }

    const payload = getStatusPayload(state)

    expect(state.routeHistory.length).toBe(DEFAULT_HISTORY_LIMIT)
    expect(state.routeHistory[0]?.ts).toBe("t-1")
    expect(state.portModelCounts.get(4141)?.get("gpt-4.1")).toBe(201)
    expect(payload.routeHistorySize).toBe(DEFAULT_HISTORY_LIMIT)
    expect(payload.instances[0]).toEqual({
      name: "alpha",
      port: 4141,
      models: ["gpt-4.1"],
      healthy: true,
      requestCounts: { "gpt-4.1": 201 },
      lastActive: "t-200",
      cooldownUntil: null,
      remainingCooldownMs: 0,
      upstreamRetryAfter: null,
      headerSnapshot: {
        premiumUsage: null,
        sessionRateLimit: null,
        weeklyRateLimit: null,
      },
    })
  })

  test("getStatusPayload exposes cooldownUntil, remainingCooldownMs, and upstreamRetryAfter", () => {
    const state = createState()
    const cooldownUntilMs = Date.now() + 5000
    state.portCooldownUntil.set(4141, cooldownUntilMs)
    state.portCooldownRetryAfter.set(4141, "30187")

    const payload = getStatusPayload(state)
    const alpha = payload.instances.find((instance) => instance.port === 4141)

    expect(alpha).toBeDefined()
    if (!alpha) throw new Error("unreachable")
    expect(alpha.cooldownUntil).toBe(new Date(cooldownUntilMs).toISOString())
    expect(alpha.remainingCooldownMs).toBeGreaterThan(0)
    expect(alpha.remainingCooldownMs).toBeLessThanOrEqual(5000)
    expect(alpha.upstreamRetryAfter).toBe("30187")
  })

  test("getStatusPayload exposes upstream header snapshots per instance", () => {
    const state = createState()
    state.portHeaderSnapshots.set(4141, {
      premiumUsage: { used: 210.9, total: 300 },
      sessionRateLimit: {
        remaining: 5.7,
        resetAt: "2026-04-21T06:35:37Z",
      },
      weeklyRateLimit: {
        remaining: 74.9,
        resetAt: "2026-04-27T00:00:00Z",
      },
    })

    const payload = getStatusPayload(state)
    const alpha = payload.instances.find((instance) => instance.port === 4141)

    expect(alpha?.headerSnapshot).toEqual({
      premiumUsage: { used: 210.9, total: 300 },
      sessionRateLimit: {
        remaining: 5.7,
        resetAt: "2026-04-21T06:35:37Z",
      },
      weeklyRateLimit: {
        remaining: 74.9,
        resetAt: "2026-04-27T00:00:00Z",
      },
    })
    expect(
      payload.instances.find((instance) => instance.port === 4142)
        ?.headerSnapshot,
    ).toEqual({
      premiumUsage: null,
      sessionRateLimit: null,
      weeklyRateLimit: null,
    })
  })

  test("discoverModels keeps all discovered models when allowlist is empty", async () => {
    const state = createStickyRouterState([
      { name: "company", port: 4142, allowedModels: [] },
    ])
    const fetchStub = createDiscoverModelsFetchStub({
      data: [{ id: "gpt-5.4" }, { id: "gemini-3.1-pro-preview" }],
    })

    await discoverModels(state, () => {}, fetchStub)

    expect(state.portToModels.get(4142)).toEqual([
      "gpt-5.4",
      "gemini-3.1-pro-preview",
    ])
  })

  test("discoverModels filters discovered models through non-empty allowlist", async () => {
    const state = createStickyRouterState([
      {
        name: "personal",
        port: 4141,
        allowedModels: ["claude-opus-4.7", "claude-sonnet-4.6"],
      },
    ])
    const fetchStub = createDiscoverModelsFetchStub({
      data: [
        { id: "claude-opus-4.7", object: "model" },
        { id: "claude-sonnet-4.6", object: "model" },
        { id: "gpt-5.4", object: "model" },
      ],
    })

    await discoverModels(state, () => {}, fetchStub)

    expect(state.portToModels.get(4141)).toEqual([
      "claude-opus-4.7",
      "claude-sonnet-4.6",
    ])
    expect(state.modelDetails.has("gpt-5.4")).toBe(false)
  })

  test("clearRouteHistory and clearSessionBindings reset mutable state", () => {
    const state = createState()
    state.routeHistory.push({
      ts: "now",
      sid: "session-1",
      agent: "atlas",
      model: "gpt-4.1",
      provider: "openai",
      port: 4141,
      reason: "new",
      instanceName: "alpha",
    })
    state.sessionBindings.set("session-1:atlas:gpt-4.1", 4141)

    clearRouteHistory(state)
    clearSessionBindings(state)

    expect(state.routeHistory).toEqual([])
    expect(state.sessionBindings.size).toBe(0)
  })
})

describe("updateUpstreamHeaderSnapshot last-known-good", () => {
  test("merges by field so a later null header does not clobber a prior good snapshot", async () => {
    const { updateUpstreamHeaderSnapshot } = await import("../../router/state")
    const state = createState()

    // First request returns full quota + session + weekly headers.
    const goodHeaders = new Headers({
      "x-quota-snapshot-premium_interactions":
        "ent=300&ov=0.0&ovPerm=false&rem=29.7&rst=2026-05-01T00%3A00%3A00Z",
      "x-usage-ratelimit-session":
        "ent=0&ov=0.0&ovPerm=false&rem=5.7&rst=2026-04-21T06%3A35%3A37Z",
      "x-usage-ratelimit-weekly":
        "ent=0&ov=0.0&ovPerm=false&rem=74.9&rst=2026-04-27T00%3A00%3A00Z",
    })
    updateUpstreamHeaderSnapshot(state, 4141, goodHeaders)

    // Subsequent request (e.g., streaming response, WS-backed responses)
    // returns no quota headers at all. Snapshot must keep the prior values.
    updateUpstreamHeaderSnapshot(state, 4141, new Headers())

    const snapshot = state.portHeaderSnapshots.get(4141)
    expect(snapshot?.premiumUsage).toEqual({ used: 210.9, total: 300 })
    expect(snapshot?.sessionRateLimit).toEqual({
      remaining: 5.7,
      resetAt: "2026-04-21T06:35:37Z",
    })
    expect(snapshot?.weeklyRateLimit).toEqual({
      remaining: 74.9,
      resetAt: "2026-04-27T00:00:00Z",
    })
  })

  test("overwrites individual fields when a fresh non-null value is provided", async () => {
    const { updateUpstreamHeaderSnapshot } = await import("../../router/state")
    const state = createState()

    updateUpstreamHeaderSnapshot(
      state,
      4141,
      new Headers({
        "x-quota-snapshot-premium_interactions":
          "ent=300&ov=0.0&ovPerm=false&rem=50.0&rst=2026-05-01T00%3A00%3A00Z",
      }),
    )

    updateUpstreamHeaderSnapshot(
      state,
      4141,
      new Headers({
        "x-quota-snapshot-premium_interactions":
          "ent=300&ov=0.0&ovPerm=false&rem=10.0&rst=2026-05-01T00%3A00%3A00Z",
      }),
    )

    expect(state.portHeaderSnapshots.get(4141)?.premiumUsage).toEqual({
      used: 270,
      total: 300,
    })
  })
})
