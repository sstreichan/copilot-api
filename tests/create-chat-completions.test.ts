import {
  test,
  expect,
  mock,
  spyOn,
  beforeEach,
  afterEach,
  describe,
} from "bun:test"

import type { ChatCompletionsPayload } from "../src/services/copilot/create-chat-completions"

import { clearSmartAgentCache } from "../src/lib/smart-agent"
import { state } from "../src/lib/state"
import { createChatCompletions } from "../src/services/copilot/create-chat-completions"
import * as telemetryModule from "../src/services/telemetry/telemetry"

/* eslint-disable @typescript-eslint/no-non-null-assertion */

// Telemetry mock (captures modelCallId for assertions)
let capturedModelCallId: string | undefined

// Mock state
state.copilotToken = "test-token"
state.githubToken = "test-github-token"
state.vsCodeVersion = "1.0.0"
state.accountType = "individual"

// Track calls for assertions
let fetchCalls: Array<{ url: string; headers: Record<string, string> }> = []

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

describe("Interaction headers (Wave 1/2)", () => {
  test("includes X-Interaction-Id from state.interactionId", async () => {
    // @ts-expect-error - Mock fetch
    globalThis.fetch = createFetchMock()

    const payload: ChatCompletionsPayload = {
      messages: [{ role: "user", content: "hi" }],
      model: "gpt-test",
    }
    await createChatCompletions(payload)

    const chatCall = fetchCalls.find((c) => c.url.includes("chat/completions"))
    expect(chatCall).toBeDefined()
    expect(chatCall!.headers["X-Interaction-Id"]).toBe(
      "test-interaction-id-static",
    )
  })

  test("X-Agent-Task-Id equals x-request-id", async () => {
    // @ts-expect-error - Mock fetch
    globalThis.fetch = createFetchMock()

    const payload: ChatCompletionsPayload = {
      messages: [{ role: "user", content: "hi" }],
      model: "gpt-test",
    }
    await createChatCompletions(payload)

    const chatCall = fetchCalls.find((c) => c.url.includes("chat/completions"))
    expect(chatCall).toBeDefined()
    expect(chatCall!.headers["X-Agent-Task-Id"]).toBe(
      chatCall!.headers["x-request-id"],
    )
  })

  test("X-Interaction-Type equals openai-intent", async () => {
    // @ts-expect-error - Mock fetch
    globalThis.fetch = createFetchMock()

    const payload: ChatCompletionsPayload = {
      messages: [{ role: "user", content: "hi" }],
      model: "gpt-test",
    }
    await createChatCompletions(payload)

    const chatCall = fetchCalls.find((c) => c.url.includes("chat/completions"))
    expect(chatCall).toBeDefined()
    expect(chatCall!.headers["X-Interaction-Type"]).toBe(
      chatCall!.headers["openai-intent"],
    )
  })

  test("passes non-empty modelCallId string to telemetry", async () => {
    capturedModelCallId = undefined
    // @ts-expect-error - Mock fetch
    globalThis.fetch = createFetchMock()

    const payload: ChatCompletionsPayload = {
      messages: [{ role: "user", content: "hi" }],
      model: "gpt-test",
    }
    await createChatCompletions(payload)

    expect(capturedModelCallId).toBeDefined()
    expect(typeof capturedModelCallId).toBe("string")
    expect(capturedModelCallId!.length).toBeGreaterThan(0)
  })
})

beforeEach(() => {
  fetchCalls = []
  state.forceAgent = false
  state.interactionId = "test-interaction-id-static"
  capturedModelCallId = undefined
  clearSmartAgentCache() // Clear cache between tests

  // Capture modelCallId using spyOn (can be restored by mock.restore())
  spyOn(telemetryModule, "trackRequestSent").mockImplementation(
    (
      _model: string,
      _accountType: string,
      _requestId?: string,
      modelCallId?: string,
      // eslint-disable-next-line max-params
    ) => {
      capturedModelCallId = modelCallId
    },
  )
  spyOn(telemetryModule, "trackResponseSuccess").mockImplementation(() => {})
  spyOn(telemetryModule, "trackResponseError").mockImplementation(() => {})
})

afterEach(() => {
  state.forceAgent = false
  mock.restore()
})

describe("X-Initiator basic behavior", () => {
  test("sets X-Initiator to agent if tool/assistant present", async () => {
    // @ts-expect-error - Mock fetch
    globalThis.fetch = createFetchMock()

    const payload: ChatCompletionsPayload = {
      messages: [
        { role: "user", content: "hi" },
        { role: "tool", content: "tool call" },
      ],
      model: "gpt-test",
    }
    await createChatCompletions(payload)

    // Find the chat completions call (not usage API)
    const chatCall = fetchCalls.find((c) => c.url.includes("chat/completions"))
    expect(chatCall).toBeDefined()
    expect(chatCall!.headers["X-Initiator"]).toBe("agent")
  })

  test("sets X-Initiator to user if only user present", async () => {
    // @ts-expect-error - Mock fetch
    globalThis.fetch = createFetchMock()

    const payload: ChatCompletionsPayload = {
      messages: [
        { role: "user", content: "hi" },
        { role: "user", content: "hello again" },
      ],
      model: "gpt-test",
    }
    await createChatCompletions(payload)

    const chatCall = fetchCalls.find((c) => c.url.includes("chat/completions"))
    expect(chatCall).toBeDefined()
    expect(chatCall!.headers["X-Initiator"]).toBe("user")
  })
})

describe("Smart agent mode (-F flag)", () => {
  test("forces agent when over budget", async () => {
    state.forceAgent = true
    // Mock: Day ~15 of 28-day month, entitlement 280, remaining 100 < expected ~130
    // @ts-expect-error - Mock fetch
    globalThis.fetch = createFetchMock({
      ok: true,
      data: {
        quota_reset_date: "2026-02-28",
        quota_snapshots: {
          premium_interactions: { entitlement: 280, remaining: 100 },
        },
      },
    })

    const payload: ChatCompletionsPayload = {
      messages: [{ role: "user", content: "hi" }],
      model: "gpt-test",
    }
    await createChatCompletions(payload)

    const chatCall = fetchCalls.find((c) => c.url.includes("chat/completions"))
    expect(chatCall).toBeDefined()
    expect(chatCall!.headers["X-Initiator"]).toBe("agent")
  })

  test("uses existing logic when on budget (user message → user)", async () => {
    state.forceAgent = true
    fetchCalls = [] // Clear before this test

    // Today is Feb 2, 2026. For 28-day month:
    // expected = 280 - (2 * 10) = 260
    // remaining = 270 > 260 → on budget
    const mockFn = mock(
      (url: string, opts: { headers: Record<string, string> }) => {
        fetchCalls.push({ url, headers: opts.headers })

        if (url.includes("copilot_internal/user")) {
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                quota_reset_date: "2026-02-28",
                quota_snapshots: {
                  premium_interactions: { entitlement: 280, remaining: 270 },
                },
              }),
          })
        }

        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              id: "123",
              object: "chat.completion",
              choices: [],
            }),
        })
      },
    )
    // @ts-expect-error - Mock fetch
    globalThis.fetch = mockFn

    const payload: ChatCompletionsPayload = {
      messages: [{ role: "user", content: "hi" }],
      model: "gpt-test",
    }
    await createChatCompletions(payload)

    const chatCall = fetchCalls.find((c) => c.url.includes("chat/completions"))
    expect(chatCall).toBeDefined()
    // On budget + user message → should be "user"
    expect(chatCall!.headers["X-Initiator"]).toBe("user")
  })

  test("uses existing logic when on budget (tool message → agent)", async () => {
    state.forceAgent = true
    // @ts-expect-error - Mock fetch
    globalThis.fetch = createFetchMock({
      ok: true,
      data: {
        quota_reset_date: "2026-02-28",
        quota_snapshots: {
          premium_interactions: { entitlement: 280, remaining: 200 },
        },
      },
    })

    const payload: ChatCompletionsPayload = {
      messages: [
        { role: "user", content: "hi" },
        { role: "tool", content: "result" },
      ],
      model: "gpt-test",
    }
    await createChatCompletions(payload)

    const chatCall = fetchCalls.find((c) => c.url.includes("chat/completions"))
    expect(chatCall).toBeDefined()
    // On budget + tool message → should be "agent" (existing logic)
    expect(chatCall!.headers["X-Initiator"]).toBe("agent")
  })

  test("defaults to agent on API failure", async () => {
    state.forceAgent = true
    // @ts-expect-error - Mock fetch
    globalThis.fetch = createFetchMock({ ok: false })

    const payload: ChatCompletionsPayload = {
      messages: [{ role: "user", content: "hi" }],
      model: "gpt-test",
    }
    await createChatCompletions(payload)

    const chatCall = fetchCalls.find((c) => c.url.includes("chat/completions"))
    expect(chatCall).toBeDefined()
    expect(chatCall!.headers["X-Initiator"]).toBe("agent")
  })
})
