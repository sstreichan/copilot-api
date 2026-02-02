import { test, expect, mock, beforeEach } from "bun:test"

import type { AnthropicMessagesPayload } from "../src/routes/messages/anthropic-types"

import { clearSmartAgentCache } from "../src/lib/smart-agent"
import { state } from "../src/lib/state"
import { createMessages } from "../src/services/copilot/create-messages"

/* eslint-disable @typescript-eslint/no-non-null-assertion */

// Mock state
state.copilotToken = "test-token"
state.vsCodeVersion = "1.0.0"
state.accountType = "individual"

// Helper to mock fetch
let fetchMock: ReturnType<typeof mock>

beforeEach(() => {
  state.forceAgent = false
  clearSmartAgentCache() // Clear cache between tests
  fetchMock = mock(
    (_url: string, opts: { headers: Record<string, string> }) => {
      return {
        ok: true,
        status: 200,
        json: () => ({
          id: "msg-123",
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: "Hello" }],
          model: "claude-sonnet-4-20250514",
          stop_reason: "end_turn",
          usage: { input_tokens: 10, output_tokens: 5 },
        }),
        body: new ReadableStream(),
        headers: opts.headers,
      }
    },
  )
  // @ts-expect-error - Mock fetch doesn't implement all fetch properties
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch = fetchMock
})

test("calls /v1/messages endpoint", async () => {
  const payload: AnthropicMessagesPayload = {
    model: "claude-sonnet-4-20250514",
    max_tokens: 1024,
    messages: [{ role: "user", content: "hi" }],
  }
  await createMessages(payload)
  expect(fetchMock).toHaveBeenCalled()
  const url = fetchMock.mock.calls[0][0] as string
  expect(url).toContain("/v1/messages")
})

test("sets X-Initiator to user by default", async () => {
  const payload: AnthropicMessagesPayload = {
    model: "claude-sonnet-4-20250514",
    max_tokens: 1024,
    messages: [{ role: "user", content: "hi" }],
  }
  await createMessages(payload, { initiator: "user" })
  const headers = (
    fetchMock.mock.calls[0][1] as { headers: Record<string, string> }
  ).headers
  expect(headers["X-Initiator"]).toBe("user")
})

test("sets X-Initiator to agent when specified", async () => {
  const payload: AnthropicMessagesPayload = {
    model: "claude-sonnet-4-20250514",
    max_tokens: 1024,
    messages: [{ role: "user", content: "hi" }],
  }
  await createMessages(payload, { initiator: "agent" })
  const headers = (
    fetchMock.mock.calls[0][1] as { headers: Record<string, string> }
  ).headers
  expect(headers["X-Initiator"]).toBe("agent")
})

test("forces X-Initiator to agent when state.forceAgent is true", async () => {
  state.forceAgent = true
  state.githubToken = "test-github-token"

  const payload: AnthropicMessagesPayload = {
    model: "claude-sonnet-4-20250514",
    max_tokens: 1024,
    messages: [{ role: "user", content: "hi" }],
  }
  await createMessages(payload, { initiator: "user" })

  // With smart agent mode, first call is usage API, second is messages API
  // Find the /v1/messages call
  const messagesCall = fetchMock.mock.calls.find((call) =>
    (call[0] as string).includes("/v1/messages"),
  )
  expect(messagesCall).toBeDefined()
  const headers = (messagesCall![1] as { headers: Record<string, string> })
    .headers
  expect(headers["X-Initiator"]).toBe("agent")
})

test("forwards anthropic-beta header when provided", async () => {
  const payload: AnthropicMessagesPayload = {
    model: "claude-sonnet-4-20250514",
    max_tokens: 1024,
    messages: [{ role: "user", content: "hi" }],
  }
  await createMessages(payload, {
    anthropicBeta: "max-tokens-3-5-sonnet-2024-07-15",
  })
  const headers = (
    fetchMock.mock.calls[0][1] as { headers: Record<string, string> }
  ).headers
  expect(headers["anthropic-beta"]).toBe("max-tokens-3-5-sonnet-2024-07-15")
})

test("does not include anthropic-beta header when not provided", async () => {
  const payload: AnthropicMessagesPayload = {
    model: "claude-sonnet-4-20250514",
    max_tokens: 1024,
    messages: [{ role: "user", content: "hi" }],
  }
  await createMessages(payload)
  const headers = (
    fetchMock.mock.calls[0][1] as { headers: Record<string, string> }
  ).headers
  expect(headers["anthropic-beta"]).toBeUndefined()
})

test("passes payload with forced temperature=1 to endpoint", async () => {
  const payload: AnthropicMessagesPayload = {
    model: "claude-sonnet-4-20250514",
    max_tokens: 2048,
    messages: [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi there" },
      { role: "user", content: "how are you?" },
    ],
    system: "You are a helpful assistant.",
    temperature: 0.7, // This should be overridden to 1
  }
  await createMessages(payload)
  const body = (fetchMock.mock.calls[0][1] as { body: string }).body
  const parsed = JSON.parse(body) as AnthropicMessagesPayload
  // temperature is forced to 1 for deep thinking
  expect(parsed.temperature).toBe(1)
  // Other fields remain unchanged
  expect(parsed.model).toBe(payload.model)
  expect(parsed.max_tokens).toBe(payload.max_tokens)
  expect(parsed.messages).toEqual(payload.messages)
  expect(parsed.system).toBe(payload.system)
})

test("returns raw Response object", async () => {
  const payload: AnthropicMessagesPayload = {
    model: "claude-sonnet-4-20250514",
    max_tokens: 1024,
    messages: [{ role: "user", content: "hi" }],
  }
  const response = await createMessages(payload)
  // Should return the mock response object
  expect(response).toHaveProperty("ok")
  expect(response).toHaveProperty("status")
  expect(response).toHaveProperty("body")
  expect(response).toHaveProperty("json")
})

test("throws error when copilot token is missing", async () => {
  const originalToken = state.copilotToken
  state.copilotToken = undefined

  const payload: AnthropicMessagesPayload = {
    model: "claude-sonnet-4-20250514",
    max_tokens: 1024,
    messages: [{ role: "user", content: "hi" }],
  }

  try {
    await createMessages(payload)
    expect.unreachable("Should have thrown")
  } catch (error) {
    expect((error as Error).message).toBe("Copilot token not found")
  } finally {
    // eslint-disable-next-line require-atomic-updates
    state.copilotToken = originalToken
  }
})

test("throws HTTPError when response is not ok", async () => {
  // Override fetch mock to return error response
  const mockResponse = {
    ok: false,
    status: 500,
    json: () => Promise.resolve({ error: "Internal Server Error" }),
    clone: () => mockResponse,
  }
  const errorFetchMock = mock(() => mockResponse)
  // @ts-expect-error - Mock fetch doesn't implement all fetch properties
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch = errorFetchMock

  const payload: AnthropicMessagesPayload = {
    model: "claude-sonnet-4-20250514",
    max_tokens: 1024,
    messages: [{ role: "user", content: "hi" }],
  }

  try {
    await createMessages(payload)
    expect.unreachable("Should have thrown")
  } catch (error) {
    expect((error as Error).message).toBe("Failed to create native messages")
  }
})

test("sets copilot-vision-request header when payload contains image block", async () => {
  const payload: AnthropicMessagesPayload = {
    model: "claude-sonnet-4-20250514",
    max_tokens: 1024,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "What is in this image?" },
          {
            type: "image",
            source: {
              type: "base64",
              media_type: "image/png",
              data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
            },
          },
        ],
      },
    ],
  }
  await createMessages(payload)
  const headers = (
    fetchMock.mock.calls[0][1] as { headers: Record<string, string> }
  ).headers
  expect(headers["copilot-vision-request"]).toBe("true")
})

test("sets copilot-vision-request header when tool_result contains nested image", async () => {
  const payload: AnthropicMessagesPayload = {
    model: "claude-sonnet-4-20250514",
    max_tokens: 1024,
    messages: [
      { role: "user", content: "Take a screenshot" },
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "tool_123",
            name: "screenshot",
            input: {},
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "tool_123",
            content: [
              { type: "text", text: "Screenshot taken" },
              {
                type: "image",
                source: {
                  type: "base64",
                  media_type: "image/png",
                  data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
                },
              },
            ],
          },
        ],
      },
    ],
  }
  await createMessages(payload)
  const headers = (
    fetchMock.mock.calls[0][1] as { headers: Record<string, string> }
  ).headers
  expect(headers["copilot-vision-request"]).toBe("true")
})

test("does not set copilot-vision-request header for text-only messages", async () => {
  const payload: AnthropicMessagesPayload = {
    model: "claude-sonnet-4-20250514",
    max_tokens: 1024,
    messages: [{ role: "user", content: "Hello, how are you?" }],
  }
  await createMessages(payload)
  const headers = (
    fetchMock.mock.calls[0][1] as { headers: Record<string, string> }
  ).headers
  expect(headers["copilot-vision-request"]).toBeUndefined()
})
