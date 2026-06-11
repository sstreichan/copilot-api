import { describe, expect, test } from "bun:test"

import {
  createStickyRouterState,
  getAvailablePorts,
  getStatusPayload,
  pickPort,
} from "../../router/state"

const baseInstances = [
  { name: "alpha", port: 4141 },
  { name: "beta", port: 4142 },
]

describe("sticky router disabled ports", () => {
  test("instances default to enabled (disabled === false) in StatusPayload", () => {
    const state = createStickyRouterState(
      baseInstances.map((inst) => ({ ...inst, models: ["gpt-4.1"] })),
    )
    const payload = getStatusPayload(state)

    for (const instance of payload.instances) {
      expect(instance.disabled).toBe(false)
    }
    expect(state.disabledPorts.size).toBe(0)
  })

  test("getAvailablePorts excludes disabled ports alongside cooldown", () => {
    const state = createStickyRouterState(
      baseInstances.map((inst) => ({ ...inst, models: ["gpt-4.1"] })),
    )
    const ports = [4141, 4142]
    const nowMs = Date.now()

    // baseline: both ports available
    expect(getAvailablePorts(state, ports, nowMs)).toEqual([4141, 4142])

    // disable 4141 -> only 4142 remains
    state.disabledPorts.add(4141)
    expect(getAvailablePorts(state, ports, nowMs)).toEqual([4142])

    // disable both -> none
    state.disabledPorts.add(4142)
    expect(getAvailablePorts(state, ports, nowMs)).toEqual([])

    // re-enable 4141 -> 4141 returns
    state.disabledPorts.delete(4141)
    expect(getAvailablePorts(state, ports, nowMs)).toEqual([4141])
  })

  test("pickPort returns null when every candidate port is disabled", () => {
    const state = createStickyRouterState(
      baseInstances.map((inst) => ({ ...inst, models: ["gpt-4.1"] })),
    )
    state.disabledPorts.add(4141)
    state.disabledPorts.add(4142)

    expect(
      pickPort(state, {
        sessionId: null,
        agent: "atlas",
        model: "gpt-4.1",
        nowMs: Date.now(),
      }),
    ).toBeNull()
  })

  test("getStatusPayload surfaces disabled:true after add and reflects removal", () => {
    const state = createStickyRouterState(
      baseInstances.map((inst) => ({ ...inst, models: ["gpt-4.1"] })),
    )

    state.disabledPorts.add(4141)
    const disabledPayload = getStatusPayload(state)
    const byPort = Object.fromEntries(
      disabledPayload.instances.map((inst) => [inst.port, inst.disabled]),
    )
    expect(byPort).toEqual({ 4141: true, 4142: false })

    // after removal, both report disabled:false again
    state.disabledPorts.delete(4141)
    const restored = getStatusPayload(state)
    for (const instance of restored.instances) {
      expect(instance.disabled).toBe(false)
    }
  })
})
