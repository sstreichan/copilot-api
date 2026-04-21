import { afterEach, beforeEach, describe, expect, test } from "bun:test"

import {
  formatError,
  getBindingKey,
  getHeaderValue,
  isRecord,
  parseUpstreamHeaderSnapshot,
  parseInstances,
  parseModelFromBody,
  parseModelIds,
  parseModelObjects,
  readPort,
} from "../../router/lib"

const TEST_PORT_ENV = "STICKY_ROUTER_TEST_PORT"

describe("router/lib pure helpers", () => {
  beforeEach(() => {
    process.env[TEST_PORT_ENV] = undefined
  })

  afterEach(() => {
    process.env[TEST_PORT_ENV] = undefined
  })

  test("readPort returns parsed positive env value", () => {
    process.env[TEST_PORT_ENV] = "4242"

    expect(readPort(TEST_PORT_ENV, 4140)).toBe(4242)
  })

  test("readPort falls back for missing, invalid, and non-positive values", () => {
    expect(readPort(TEST_PORT_ENV, 4140)).toBe(4140)

    process.env[TEST_PORT_ENV] = "not-a-number"
    expect(readPort(TEST_PORT_ENV, 4140)).toBe(4140)

    process.env[TEST_PORT_ENV] = "0"
    expect(readPort(TEST_PORT_ENV, 4140)).toBe(4140)
  })

  test("isRecord only accepts non-null objects", () => {
    expect(isRecord({ ok: true })).toBe(true)
    expect(isRecord([])).toBe(true)
    expect(isRecord(null)).toBe(false)
    expect(isRecord("nope")).toBe(false)
  })

  test("formatError prefers Error.message and stringifies unknown values", () => {
    expect(formatError(new Error("boom"))).toBe("boom")
    expect(formatError({ code: 500 })).toBe("[object Object]")
  })

  test("parseInstances keeps only valid name/port pairs", () => {
    expect(
      parseInstances([
        { name: "alpha", port: 4141 },
        { name: "broken" },
        { port: 4142 },
        "invalid",
        { name: "beta", port: 4142 },
      ]),
    ).toEqual([
      { name: "alpha", port: 4141 },
      { name: "beta", port: 4142 },
    ])
  })

  test("parseModelIds extracts ids from OpenAI-style model payloads", () => {
    expect(
      parseModelIds({
        data: [{ id: "gpt-4.1" }, { name: "ignored" }, { id: "claude-3.7" }],
      }),
    ).toEqual(["gpt-4.1", "claude-3.7"])
  })

  test("parseModelObjects extracts full model objects from OpenAI-style payloads", () => {
    const input = {
      data: [
        { id: "gpt-4.1", object: "model", limits: { context_window: 128000 } },
        { name: "no-id" },
        {
          id: "claude-3.7",
          object: "model",
          limits: { context_window: 200000 },
        },
      ],
    }
    const result = parseModelObjects(input)
    expect(result).toHaveLength(2)
    expect(result[0].id).toBe("gpt-4.1")
    expect(result[1].id).toBe("claude-3.7")
    expect((result[0].limits as Record<string, unknown>).context_window).toBe(
      128000,
    )
  })

  test("parseModelObjects returns empty array for invalid input", () => {
    expect(parseModelObjects(null)).toEqual([])
    expect(parseModelObjects("string")).toEqual([])
    expect(parseModelObjects({ data: "not-array" })).toEqual([])
    expect(parseModelObjects({ data: [{ name: "no-id" }] })).toEqual([])
  })

  test("parseModelFromBody returns model or empty string", () => {
    expect(parseModelFromBody('{"model":"gpt-4.1"}')).toBe("gpt-4.1")
    expect(parseModelFromBody('{"messages":[]}')).toBe("")
    expect(parseModelFromBody("not-json")).toBe("")
  })

  test("getHeaderValue trims strings and falls back to underscore", () => {
    const req = new Request("http://localhost/", {
      headers: { "x-oc-agent": " atlas " },
    })

    expect(getHeaderValue(req, "x-oc-agent")).toBe("atlas")
    expect(getHeaderValue(req, "x-oc-provider")).toBe("_")
  })

  test("getBindingKey composes sticky binding keys only when session exists", () => {
    expect(getBindingKey("session-1", "atlas", "gpt-4.1")).toBe(
      "session-1:atlas:gpt-4.1",
    )
    expect(getBindingKey(null, "atlas", "gpt-4.1")).toBeNull()
  })

  test("parseUpstreamHeaderSnapshot reads premium, session, and weekly headers", () => {
    const result = parseUpstreamHeaderSnapshot(
      new Headers({
        "x-quota-snapshot-premium_interactions":
          "ent=300&ov=0.0&ovPerm=false&rem=29.7&rst=2026-05-01T00%3A00%3A00Z",
        "x-usage-ratelimit-session":
          "ent=0&ov=0.0&ovPerm=false&rem=5.7&rst=2026-04-21T06%3A35%3A37Z",
        "x-usage-ratelimit-weekly":
          "ent=0&ov=0.0&ovPerm=false&rem=74.9&rst=2026-04-27T00%3A00%3A00Z",
      }),
    )

    expect(result).toEqual({
      premiumUsage: {
        used: 210.9,
        total: 300,
      },
      sessionRateLimit: {
        remaining: 5.7,
        resetAt: "2026-04-21T06:35:37Z",
      },
      weeklyRateLimit: {
        remaining: 74.9,
        resetAt: "2026-04-27T00:00:00Z",
      },
    })
  })

  test("parseUpstreamHeaderSnapshot tolerates missing or invalid values", () => {
    expect(
      parseUpstreamHeaderSnapshot(
        new Headers({
          "x-usage-ratelimit-session": "rem=nope&rst=invalid",
        }),
      ),
    ).toEqual({
      premiumUsage: null,
      sessionRateLimit: null,
      weeklyRateLimit: null,
    })
  })

  test("parseUpstreamHeaderSnapshot rejects out-of-range premium percentages", () => {
    expect(
      parseUpstreamHeaderSnapshot(
        new Headers({
          "x-quota-snapshot-premium_interactions":
            "ent=300&ov=0.0&ovPerm=false&rem=120&rst=2026-05-01T00%3A00%3A00Z",
        }),
      ),
    ).toEqual({
      premiumUsage: null,
      sessionRateLimit: null,
      weeklyRateLimit: null,
    })
  })

  test("parseUpstreamHeaderSnapshot rejects negative rate-limit remaining values", () => {
    expect(
      parseUpstreamHeaderSnapshot(
        new Headers({
          "x-usage-ratelimit-weekly": "rem=-1&rst=2026-04-27T00%3A00%3A00Z",
        }),
      ),
    ).toEqual({
      premiumUsage: null,
      sessionRateLimit: null,
      weeklyRateLimit: null,
    })
  })
})
