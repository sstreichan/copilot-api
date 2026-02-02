import { test, expect, describe, mock, afterEach } from "bun:test"

import {
  shouldUseAgentMode,
  getSmartAgentDecision,
} from "../src/services/github/get-copilot-usage"

describe("shouldUseAgentMode", () => {
  // MECE test categories:
  // 1. Basic behavior (over budget / on budget)
  // 2. Boundary cases (exact budget, day 1, last day, different month lengths)

  // --- Basic behavior ---

  test("returns true when over budget (remaining < expected)", () => {
    // Day 15 of 30-day month, 300 entitlement
    // expected = 300 - (15 * 300/30) = 300 - 150 = 150
    // remaining = 120 < 150 → over budget
    const result = shouldUseAgentMode({
      entitlement: 300,
      remaining: 120,
      dayOfMonth: 15,
      daysInMonth: 30,
    })
    expect(result).toBe(true)
  })

  test("returns false when on budget (remaining > expected)", () => {
    // Day 15 of 30-day month, 300 entitlement
    // expected = 150, remaining = 180 > 150 → on budget
    const result = shouldUseAgentMode({
      entitlement: 300,
      remaining: 180,
      dayOfMonth: 15,
      daysInMonth: 30,
    })
    expect(result).toBe(false)
  })

  // --- Boundary cases ---

  test("returns true when exactly on budget (remaining === expected)", () => {
    // expected = 150, remaining = 150 → exactly on budget, trigger agent to protect
    const result = shouldUseAgentMode({
      entitlement: 300,
      remaining: 150,
      dayOfMonth: 15,
      daysInMonth: 30,
    })
    expect(result).toBe(true)
  })

  test("returns false on day 1 with full quota", () => {
    // Day 1: expected = 300 - (1 * 10) = 290
    // remaining = 300 >= 290 → on budget
    const result = shouldUseAgentMode({
      entitlement: 300,
      remaining: 300,
      dayOfMonth: 1,
      daysInMonth: 30,
    })
    expect(result).toBe(false)
  })

  test("returns true on day 1 when already over budget", () => {
    // Day 1: expected = 290, remaining = 285 < 290 → over budget
    const result = shouldUseAgentMode({
      entitlement: 300,
      remaining: 285,
      dayOfMonth: 1,
      daysInMonth: 30,
    })
    expect(result).toBe(true)
  })

  test("returns true on last day of month with some remaining (min reserve)", () => {
    // Day 30: expected = max(5, 300 - 30*10) = max(5, 0) = 5
    // remaining = 5 <= 5 → trigger agent (at reserve threshold)
    const result = shouldUseAgentMode({
      entitlement: 300,
      remaining: 5,
      dayOfMonth: 30,
      daysInMonth: 30,
    })
    expect(result).toBe(true)
  })

  test("returns false on last day when above reserve", () => {
    // Day 30: expected = max(5, 0) = 5
    // remaining = 10 > 5 → on budget, can still use
    const result = shouldUseAgentMode({
      entitlement: 300,
      remaining: 10,
      dayOfMonth: 30,
      daysInMonth: 30,
    })
    expect(result).toBe(false)
  })

  test("handles months with different lengths (28-day month)", () => {
    // 28-day month, 280 entitlement → daily = 10
    // Day 14: expected = 280 - (14 * 10) = 140
    // remaining = 140 → exactly on budget, trigger agent (<=)
    const result = shouldUseAgentMode({
      entitlement: 280,
      remaining: 140,
      dayOfMonth: 14,
      daysInMonth: 28,
    })
    expect(result).toBe(true)
  })

  test("handles months with different lengths - above budget", () => {
    // 28-day month, 280 entitlement → daily = 10
    // Day 14: expected = 140, remaining = 141 > 140 → on budget
    const result = shouldUseAgentMode({
      entitlement: 280,
      remaining: 141,
      dayOfMonth: 14,
      daysInMonth: 28,
    })
    expect(result).toBe(false)
  })

  test("returns true on last day when quota exhausted", () => {
    // Day 30: expected = max(5, 300 - 30*10) = 5
    // remaining = 0 <= 5 → trigger agent
    const result = shouldUseAgentMode({
      entitlement: 300,
      remaining: 0,
      dayOfMonth: 30,
      daysInMonth: 30,
    })
    expect(result).toBe(true)
  })
})

describe("getSmartAgentDecision", () => {
  const originalFetch = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  test("returns forceAgent=true when over budget", async () => {
    // Mock: Feb has 28 days, day 15, entitlement 280, daily ~10
    // expected = 280 - (15 * 10) = 130
    // remaining = 100 < 130 → over budget → forceAgent
    // @ts-expect-error - Mock fetch
    globalThis.fetch = mock(() =>
      Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            quota_reset_date: "2026-02-28",
            quota_snapshots: {
              premium_interactions: {
                entitlement: 280,
                remaining: 100,
              },
            },
          }),
      }),
    )

    const result = await getSmartAgentDecision(new Date("2026-02-15"))
    expect(result.forceAgent).toBe(true)
    expect(result.remaining).toBe(100)
  })

  test("returns forceAgent=false when on budget (use existing logic)", async () => {
    // remaining = 200 > expected 130 → on budget → use existing logic
    // @ts-expect-error - Mock fetch
    globalThis.fetch = mock(() =>
      Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            quota_reset_date: "2026-02-28",
            quota_snapshots: {
              premium_interactions: {
                entitlement: 280,
                remaining: 200,
              },
            },
          }),
      }),
    )

    const result = await getSmartAgentDecision(new Date("2026-02-15"))
    expect(result.forceAgent).toBe(false)
    expect(result.remaining).toBe(200)
  })

  test("returns forceAgent=true on API failure (protect user quota)", async () => {
    // @ts-expect-error - Mock fetch
    globalThis.fetch = mock(() =>
      Promise.resolve({
        ok: false,
        status: 500,
      }),
    )

    const result = await getSmartAgentDecision(new Date("2026-02-15"))
    expect(result.forceAgent).toBe(true)
    expect(result.error).toBeDefined()
  })
})
