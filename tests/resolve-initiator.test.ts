import { test, expect, mock, beforeEach, afterEach, describe } from "bun:test"

import { state } from "../src/lib/state"

const midMonth = new Date("2026-02-15T00:00:00.000Z")
const earlyMonth = new Date("2026-02-02T00:00:00.000Z")

// Save original state
let originalForceAgent: boolean
let originalGithubToken: string | undefined

beforeEach(() => {
  originalForceAgent = state.forceAgent
  originalGithubToken = state.githubToken
  state.forceAgent = false
  state.githubToken = "test-github-token"
})

afterEach(() => {
  state.forceAgent = originalForceAgent
  state.githubToken = originalGithubToken
})

describe("resolveInitiatorWithSmartAgent", () => {
  test("returns defaultInitiator when state.forceAgent is false", async () => {
    state.forceAgent = false

    const { resolveInitiatorWithSmartAgent } = await import(
      "../src/lib/smart-agent"
    )

    const result = await resolveInitiatorWithSmartAgent("user", midMonth)
    expect(result.initiator).toBe("user")
    expect(result.decision).toBeUndefined()

    const result2 = await resolveInitiatorWithSmartAgent("agent")
    expect(result2.initiator).toBe("agent")
  })

  test("forces agent when over budget", async () => {
    state.forceAgent = true

    // Mock fetch: Day 15 of 28-day month, entitlement 280, remaining 100 < expected ~130
    const fetchMock = mock(() =>
      Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            quota_reset_date: "2026-02-28",
            quota_snapshots: {
              premium_interactions: { entitlement: 280, remaining: 100 },
            },
          }),
      }),
    )
    // @ts-expect-error - Mock fetch
    globalThis.fetch = fetchMock

    const { resolveInitiatorWithSmartAgent } = await import(
      "../src/lib/smart-agent"
    )

    // Clear cache before test
    const { clearSmartAgentCache } = await import("../src/lib/smart-agent")
    clearSmartAgentCache()

    const result = await resolveInitiatorWithSmartAgent("user", earlyMonth)
    expect(result.initiator).toBe("agent")
    expect(result.decision?.forceAgent).toBe(true)
  })

  test("keeps defaultInitiator when on budget", async () => {
    state.forceAgent = true

    // Mock fetch: Day 2 of 28-day month, entitlement 280, remaining 270 > expected ~260
    const fetchMock = mock(() =>
      Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            quota_reset_date: "2026-02-28",
            quota_snapshots: {
              premium_interactions: { entitlement: 280, remaining: 270 },
            },
          }),
      }),
    )
    // @ts-expect-error - Mock fetch
    globalThis.fetch = fetchMock

    const { resolveInitiatorWithSmartAgent, clearSmartAgentCache } =
      await import("../src/lib/smart-agent")

    clearSmartAgentCache()

    const result = await resolveInitiatorWithSmartAgent("user")
    expect(result.initiator).toBe("user")
    expect(result.decision?.forceAgent).toBe(false)
  })

  test("defaults to agent on API failure", async () => {
    state.forceAgent = true

    // Mock fetch: API failure
    const fetchMock = mock(() =>
      Promise.resolve({
        ok: false,
        status: 500,
      }),
    )
    // @ts-expect-error - Mock fetch
    globalThis.fetch = fetchMock

    const { resolveInitiatorWithSmartAgent, clearSmartAgentCache } =
      await import("../src/lib/smart-agent")

    clearSmartAgentCache()

    const result = await resolveInitiatorWithSmartAgent("user")
    expect(result.initiator).toBe("agent")
    expect(result.decision?.forceAgent).toBe(true)
    expect(result.decision?.error).toBeDefined()
  })

  test("caches decision when over budget (forceAgent=true)", async () => {
    state.forceAgent = true

    let callCount = 0
    const fetchMock = mock(() => {
      callCount++
      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            quota_reset_date: "2026-02-28",
            quota_snapshots: {
              // Over budget: remaining 100 < expected ~130
              premium_interactions: { entitlement: 280, remaining: 100 },
            },
          }),
      })
    })
    // @ts-expect-error - Mock fetch
    globalThis.fetch = fetchMock

    const { resolveInitiatorWithSmartAgent, clearSmartAgentCache } =
      await import("../src/lib/smart-agent")

    clearSmartAgentCache()

    // First call should fetch
    await resolveInitiatorWithSmartAgent("user", midMonth)
    const firstCallCount = callCount

    // Second call should use cache (over budget is cached)
    await resolveInitiatorWithSmartAgent("user", midMonth)
    expect(callCount).toBe(firstCallCount) // No additional fetch
  })

  test("does NOT cache decision when on budget (forceAgent=false)", async () => {
    state.forceAgent = true

    let callCount = 0
    const fetchMock = mock(() => {
      callCount++
      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            quota_reset_date: "2026-02-28",
            quota_snapshots: {
              // On budget: remaining 270 > expected ~260
              premium_interactions: { entitlement: 280, remaining: 270 },
            },
          }),
      })
    })
    // @ts-expect-error - Mock fetch
    globalThis.fetch = fetchMock

    const { resolveInitiatorWithSmartAgent, clearSmartAgentCache } =
      await import("../src/lib/smart-agent")

    clearSmartAgentCache()

    // First call should fetch
    await resolveInitiatorWithSmartAgent("user", earlyMonth)
    expect(callCount).toBe(1)

    // Second call should also fetch (on budget is NOT cached)
    await resolveInitiatorWithSmartAgent("user", earlyMonth)
    expect(callCount).toBe(2)
  })
})
