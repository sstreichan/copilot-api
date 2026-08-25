import { describe, expect, test } from "bun:test"

import { resolveSupportedReasoningEffort } from "~/lib/reasoning-effort"
import {
  mapAnthropicEffortToResponses,
  resolveEffortForLog,
} from "../src/lib/config"
describe("mapAnthropicEffortToResponses", () => {
  test("maps max to xhigh", () => {
    expect(mapAnthropicEffortToResponses("max")).toBe("xhigh")
  })

  test("maps high to high", () => {
    expect(mapAnthropicEffortToResponses("high")).toBe("high")
  })

  test("maps medium to medium", () => {
    expect(mapAnthropicEffortToResponses("medium")).toBe("medium")
  })

  test("maps low to low", () => {
    expect(mapAnthropicEffortToResponses("low")).toBe("low")
  })
})

describe("resolveEffortForLog", () => {
  test("returns request effort when provided", () => {
    expect(resolveEffortForLog("high", "any-model")).toEqual({
      value: "high",
      source: "request",
    })
  })

  test("falls back to config effort when request missing", () => {
    expect(resolveEffortForLog(undefined, "model-not-in-config")).toEqual({
      value: "high",
      source: "config",
    })
  })
})

describe("resolveSupportedReasoningEffort", () => {
  test("keeps the requested effort when it is supported", () => {
    expect(
      resolveSupportedReasoningEffort("high", ["low", "medium", "high"]),
    ).toBe("high")
    expect(resolveSupportedReasoningEffort("max", ["low", "max"])).toBe("max")
  })

  test("maps ultra to max when max is supported", () => {
    expect(
      resolveSupportedReasoningEffort("ultra", [
        "low",
        "medium",
        "high",
        "xhigh",
        "max",
      ]),
    ).toBe("max")
  })

  test("falls back to the highest supported level when max is unsupported", () => {
    expect(
      resolveSupportedReasoningEffort("max", [
        "low",
        "medium",
        "high",
        "xhigh",
      ]),
    ).toBe("xhigh")
    expect(
      resolveSupportedReasoningEffort("ultra", [
        "low",
        "medium",
        "high",
        "xhigh",
      ]),
    ).toBe("xhigh")
  })

  test("preserves valid wire efforts when capabilities are unknown", () => {
    expect(resolveSupportedReasoningEffort("none", undefined)).toBe("none")
    expect(resolveSupportedReasoningEffort("minimal", [])).toBe("minimal")
    expect(resolveSupportedReasoningEffort("low", undefined)).toBe("low")
    expect(resolveSupportedReasoningEffort("max", [])).toBe("max")
  })

  test("maps ultra to max when capabilities are unknown", () => {
    expect(resolveSupportedReasoningEffort("ultra", undefined)).toBe("max")
    expect(resolveSupportedReasoningEffort("ultra", [])).toBe("max")
  })

  test("leaves unknown efforts unresolved for upstream validation", () => {
    expect(resolveSupportedReasoningEffort("turbo", undefined)).toBeUndefined()
    expect(
      resolveSupportedReasoningEffort("turbo", ["medium", "high"]),
    ).toBeUndefined()
  })

  test("maps minimal to low when minimal is unsupported", () => {
    expect(
      resolveSupportedReasoningEffort("minimal", ["low", "medium", "high"]),
    ).toBe("low")
  })

  test("clamps requests below all supported levels to the lowest supported", () => {
    expect(
      resolveSupportedReasoningEffort("none", ["low", "medium", "high"]),
    ).toBe("low")
  })

  test("ignores unknown levels in the supported list", () => {
    expect(resolveSupportedReasoningEffort("max", ["ultra", "high"])).toBe(
      "high",
    )
  })
})
