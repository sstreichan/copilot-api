import { describe, expect, test } from "bun:test"

import {
  DEFAULT_HISTORY_LIMIT,
  clearRouteHistory,
  clearSessionBindings,
  createStickyRouterState,
  getStatusPayload,
  pickPort,
  recordRoute,
} from "../../router/state"

function createState() {
  return createStickyRouterState([
    { name: "alpha", port: 4141 },
    { name: "beta", port: 4142 },
  ])
}

describe("router state helpers", () => {
  test("pickPort round-robins when no sticky binding is available", () => {
    const state = createState()
    state.modelToPorts.set("gpt-4.1", [4141, 4142])

    expect(
      pickPort(state, { sessionId: null, agent: "atlas", model: "gpt-4.1" }),
    ).toEqual({
      port: 4141,
      reason: "new",
      bindingKey: null,
    })
    expect(
      pickPort(state, { sessionId: null, agent: "atlas", model: "gpt-4.1" }),
    ).toEqual({
      port: 4142,
      reason: "new",
      bindingKey: null,
    })
    expect(state.sessionBindings.size).toBe(0)
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

    expect(first).toEqual({
      port: 4141,
      reason: "new",
      bindingKey: "session-1:atlas:gpt-4.1",
    })
    expect(second).toEqual({
      port: 4141,
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
    })
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
