import { describe, expect, test } from "bun:test"

import {
  attachPremiumInfo,
  formatStreamLog,
  getAttachedPremiumInfo,
  getPremiumInfoFromHeaders,
} from "../src/lib/logger"

describe("getPremiumInfoFromHeaders", () => {
  test("derives remaining count from entitlement and percent remaining", () => {
    const headers = new Headers({
      "x-quota-snapshot-premium_interactions":
        "ent=1500&ov=0.0&ovPerm=false&rem=31.3&rst=2026-04-01T00%3A00%3A00Z",
    })

    expect(getPremiumInfoFromHeaders(headers)).toEqual({
      remaining: 469.5,
      total: 1500,
    })
  })

  test("returns null for unlimited or malformed premium quota snapshot", () => {
    expect(
      getPremiumInfoFromHeaders(
        new Headers({
          "x-quota-snapshot-premium_interactions":
            "ent=-1&ov=0.0&ovPerm=false&rem=100.0&rst=2026-04-01T00%3A00%3A00Z",
        }),
      ),
    ).toBeNull()

    expect(
      getPremiumInfoFromHeaders(
        new Headers({
          "x-quota-snapshot-premium_interactions": "ent=oops&rem=nope",
        }),
      ),
    ).toBeNull()
  })
})

describe("premium info attachment", () => {
  test("attaches and reads premium info on arbitrary objects", () => {
    const value = attachPremiumInfo(
      { ok: true },
      { remaining: 106.5, total: 300 },
    )
    expect(getAttachedPremiumInfo(value)).toEqual({
      remaining: 106.5,
      total: 300,
    })
  })
})

describe("formatStreamLog", () => {
  test("renders left badge with at most two decimal places", () => {
    const log = formatStreamLog({
      model: "gpt-5-mini",
      chunks: 42,
      done: true,
      premium: { remaining: 106.567, total: 300 },
    })

    expect(log).toContain("106.57")
    expect(log).not.toContain("106.567")
    expect(log).toContain("left")
  })
})
