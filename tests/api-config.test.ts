import { afterEach, describe, expect, test } from "bun:test"

import type { State } from "../src/lib/state"

import { copilotBaseUrl } from "../src/lib/api-config"

const baseState = (): State => ({
  interactionId: "test-interaction-id",
  accountType: "individual",
  manualApprove: false,
  rateLimitWait: false,
  showToken: false,
  verbose: false,
  forceAgent: false,
  nativeMessages: false,
})

describe("copilotBaseUrl", () => {
  const originalEnterpriseUrl = process.env.COPILOT_API_ENTERPRISE_URL

  afterEach(() => {
    if (originalEnterpriseUrl === undefined) {
      delete process.env.COPILOT_API_ENTERPRISE_URL
    } else {
      process.env.COPILOT_API_ENTERPRISE_URL = originalEnterpriseUrl
    }
  })

  test("uses token-provided api endpoint before account type routing", () => {
    const state = {
      ...baseState(),
      accountType: "enterprise",
      copilotApiUrl: "https://api.individual.githubcopilot.com",
    }

    expect(copilotBaseUrl(state)).toBe(
      "https://api.individual.githubcopilot.com",
    )
  })

  test("falls back to account type routing when token endpoint is unavailable", () => {
    const state = {
      ...baseState(),
      accountType: "business",
    }

    expect(copilotBaseUrl(state)).toBe("https://api.business.githubcopilot.com")
  })

  test("falls back to enterprise domain override when token endpoint is unavailable", () => {
    process.env.COPILOT_API_ENTERPRISE_URL = "company.ghe.com"
    const state = {
      ...baseState(),
      accountType: "individual",
    }

    expect(copilotBaseUrl(state)).toBe("https://copilot-api.company.ghe.com")
  })
})
