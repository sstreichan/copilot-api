import { afterEach, describe, expect, test } from "bun:test"

import type { State } from "../src/lib/state"

import {
  copilotBaseUrl,
  copilotHostHeader,
  prepareMessageProxyHeaders,
} from "../src/lib/api-config"

const baseState = (): State => ({
  interactionId: "test-interaction-id",
  accountType: "individual",
  manualApprove: false,
  rateLimitWait: false,
  showToken: false,
  verbose: false,
  forceAgent: false,
  nativeMessages: false,
  vsCodeDeviceId: "test-device-id",
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

    expect(copilotBaseUrl(state)).toBe("https://api.business.githubcopilot.com")
    expect(copilotHostHeader(state)).toBe("api.individual.githubcopilot.com")
  })

  test("falls back to account type routing when token endpoint is unavailable", () => {
    const state = {
      ...baseState(),
      accountType: "business",
    }

    expect(copilotBaseUrl(state)).toBe("https://api.business.githubcopilot.com")
    expect(copilotHostHeader(state)).toBeUndefined()
  })

  test("routes enterprise account through business domain with host masquerade", () => {
    const state = {
      ...baseState(),
      accountType: "enterprise",
    }

    expect(copilotBaseUrl(state)).toBe("https://api.business.githubcopilot.com")
    expect(copilotHostHeader(state)).toBe("api.enterprise.githubcopilot.com")
  })

  test("falls back to enterprise domain override when token endpoint is unavailable", () => {
    process.env.COPILOT_API_ENTERPRISE_URL = "company.ghe.com"
    const state = {
      ...baseState(),
      accountType: "individual",
    }

    expect(copilotBaseUrl(state)).toBe("https://copilot-api.company.ghe.com")
    expect(copilotHostHeader(state)).toBeUndefined()
  })
})

describe("prepareMessageProxyHeaders", () => {
  const originalOauthApp = process.env.COPILOT_API_OAUTH_APP

  afterEach(() => {
    if (originalOauthApp === undefined) {
      delete process.env.COPILOT_API_OAUTH_APP
      return
    }

    process.env.COPILOT_API_OAUTH_APP = originalOauthApp
  })

  test("applies message proxy headers by default", () => {
    delete process.env.COPILOT_API_OAUTH_APP

    const headers: Record<string, string> = {
      "user-agent": "GitHubCopilotChat/0.42.3",
    }

    prepareMessageProxyHeaders(headers)

    expect(headers["x-interaction-type"]).toBe("messages-proxy")
    expect(headers["openai-intent"]).toBe("messages-proxy")
    expect(headers["user-agent"]).toBe(
      "vscode_claude_code/2.1.81 (external, sdk-ts, agent-sdk/0.2.81)",
    )
    expect(headers["x-request-id"]).toBeDefined()
    expect(headers["x-agent-task-id"]).toBe(headers["x-request-id"])
  })

  test("leaves opencode headers untouched", () => {
    process.env.COPILOT_API_OAUTH_APP = "opencode"

    const headers: Record<string, string> = {
      "Openai-Intent": "conversation-edits",
      "User-Agent": "opencode/1.0.0",
    }

    prepareMessageProxyHeaders(headers)

    expect(headers).toEqual({
      "Openai-Intent": "conversation-edits",
      "User-Agent": "opencode/1.0.0",
    })
  })
})
