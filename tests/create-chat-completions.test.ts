import {
  test,
  expect,
  mock,
  beforeEach,
  afterEach,
  describe,
  spyOn,
} from "bun:test"

import type { ChatCompletionsPayload } from "../src/services/copilot/create-chat-completions"

import { state } from "../src/lib/state"
import { createChatCompletions } from "../src/services/copilot/create-chat-completions"
import * as telemetryModule from "../src/services/telemetry/telemetry"

/* eslint-disable @typescript-eslint/no-non-null-assertion */

// Mock state
state.copilotToken = "test-token"
state.githubToken = "test-github-token"
state.vsCodeVersion = "1.0.0"
state.accountType = "individual"

// Track calls for assertions
let fetchCalls: Array<{ url: string; headers: Record<string, string> }> = []
let trackPanelRequestCalls = 0
let trackGhostTextShownCalls = 0

// Helper to mock fetch - handles both usage API and chat completions
const createFetchMock = (usageResponse?: {
  ok: boolean
  data?: {
    quota_snapshots: {
      premium_interactions: { entitlement: number; remaining: number }
    }
    quota_reset_date: string
  }
}) => {
  return mock((url: string, opts: { headers: Record<string, string> }) => {
    fetchCalls.push({ url, headers: opts.headers })

    // Usage API call
    if (url.includes("copilot_internal/user")) {
      if (usageResponse?.ok) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(usageResponse.data),
        })
      }
      return Promise.resolve({ ok: false, status: 500 })
    }

    // Chat completions call
    return Promise.resolve({
      ok: true,
      json: () =>
        Promise.resolve({ id: "123", object: "chat.completion", choices: [] }),
    })
  })
}

describe("Interaction headers", () => {
  beforeEach(() => {
    fetchCalls = []
    state.interactionId = "test-interaction-id"
    state.forceAgent = false
    trackPanelRequestCalls = 0
    trackGhostTextShownCalls = 0

    spyOn(telemetryModule, "trackRequestSent").mockImplementation(() => {})
    spyOn(telemetryModule, "trackResponseSuccess").mockImplementation(() => {})
    spyOn(telemetryModule, "trackResponseError").mockImplementation(() => {})
    spyOn(telemetryModule, "scheduleFeedbackEvents").mockImplementation(
      () => {},
    )
    spyOn(telemetryModule, "trackPanelRequest").mockImplementation(() => {
      trackPanelRequestCalls += 1
    })
    spyOn(telemetryModule, "trackGhostTextShown").mockImplementation(() => {
      trackGhostTextShownCalls += 1
    })
  })

  afterEach(() => {
    mock.restore()
  })

  test("includes x-interaction-id from state.interactionId", async () => {
    // @ts-expect-error - Mock fetch
    globalThis.fetch = createFetchMock()

    const payload: ChatCompletionsPayload = {
      messages: [{ role: "user", content: "hi" }],
      model: "gpt-test",
    }
    await createChatCompletions(payload)

    const chatCall = fetchCalls.find((c) => c.url.includes("chat/completions"))
    expect(chatCall).toBeDefined()
    expect(chatCall!.headers["x-interaction-id"]).toBe("test-interaction-id")
  })

  test("emits panel and ghost telemetry after signature-retry success", async () => {
    const signatureError = {
      ok: false,
      status: 400,
      json: () =>
        Promise.resolve({ error: { message: "signature cannot be modified" } }),
      clone() {
        return this
      },
    }
    const successResponse = {
      ok: true,
      json: () =>
        Promise.resolve({
          id: "123",
          object: "chat.completion",
          choices: [],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        }),
    }

    // @ts-expect-error - Mock fetch
    globalThis.fetch = mock(
      (url: string, opts: { headers: Record<string, string> }) => {
        fetchCalls.push({ url, headers: opts.headers })

        const completionCalls = fetchCalls.filter((call) =>
          call.url.includes("chat/completions"),
        )
        return Promise.resolve(
          completionCalls.length === 1 ? signatureError : successResponse,
        )
      },
    )

    const payload: ChatCompletionsPayload = {
      messages: [{ role: "user", content: "hi" }],
      model: "gpt-test",
    }

    await createChatCompletions(payload)

    expect(trackPanelRequestCalls).toBe(1)
    expect(trackGhostTextShownCalls).toBe(1)
    expect(
      fetchCalls.filter((call) => call.url.includes("chat/completions")).length,
    ).toBe(2)
  })

  test("does not emit panel and ghost telemetry on non-retry error", async () => {
    // @ts-expect-error - Mock fetch
    globalThis.fetch = mock(
      (url: string, opts: { headers: Record<string, string> }) => {
        fetchCalls.push({ url, headers: opts.headers })
        return Promise.resolve({
          ok: false,
          status: 500,
          json: () =>
            Promise.resolve({ error: { message: "upstream failed" } }),
          clone() {
            return this
          },
        })
      },
    )

    const payload: ChatCompletionsPayload = {
      messages: [{ role: "user", content: "hi" }],
      model: "gpt-test",
    }

    try {
      await createChatCompletions(payload)
      expect.unreachable("Should have thrown")
    } catch (error) {
      expect((error as Error).message).toBe("Failed to create chat completions")
    }

    expect(trackPanelRequestCalls).toBe(0)
    expect(trackGhostTextShownCalls).toBe(0)
  })
})
