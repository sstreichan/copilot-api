import { afterEach, beforeEach, describe, expect, test } from "bun:test"

import {
  formatError,
  getBindingKey,
  getHeaderValue,
  isRecord,
  parseInstances,
  parseModelFromBody,
  parseModelIds,
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
})
