import { test, expect, mock } from "bun:test"

import { state } from "../src/lib/state"
import { createResponses } from "../src/services/copilot/create-responses"

// Mock state
state.copilotToken = "test-token"
state.vsCodeVersion = "1.0.0"
state.accountType = "individual"

// Helper to mock fetch
const fetchMock = mock(
  (_url: string, opts: { headers: Record<string, string> }) => {
    return {
      ok: true,
      json: () => ({
        id: "resp-123",
        output: [
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "ok" }],
          },
        ],
        usage: { input_tokens: 10, output_tokens: 5 },
      }),
      headers: opts.headers,
    }
  },
)
// @ts-expect-error - Mock fetch doesn't implement all fetch properties
;(globalThis as unknown as { fetch: typeof fetch }).fetch = fetchMock

test("sets X-Initiator to user when initiator is user", async () => {
  const payload = {
    model: "gpt-test",
    input: [{ role: "user" as const, content: "hi" }],
  }
  await createResponses(payload, { vision: false, initiator: "user" })
  expect(fetchMock).toHaveBeenCalled()
  const headers = (
    fetchMock.mock.calls[0][1] as { headers: Record<string, string> }
  ).headers
  expect(headers["X-Initiator"]).toBe("user")
})

test("sets X-Initiator to agent when initiator is agent", async () => {
  const payload = {
    model: "gpt-test",
    input: [{ role: "user" as const, content: "hi" }],
  }
  await createResponses(payload, { vision: false, initiator: "agent" })
  const callIndex = fetchMock.mock.calls.length - 1
  const headers = (
    fetchMock.mock.calls[callIndex][1] as { headers: Record<string, string> }
  ).headers
  expect(headers["X-Initiator"]).toBe("agent")
})

test("forces X-Initiator to agent when state.forceAgent is true", async () => {
  state.forceAgent = true
  const payload = {
    model: "gpt-test",
    input: [{ role: "user" as const, content: "hi" }],
  }
  await createResponses(payload, { vision: false, initiator: "user" })
  const callIndex = fetchMock.mock.calls.length - 1
  const headers = (
    fetchMock.mock.calls[callIndex][1] as { headers: Record<string, string> }
  ).headers
  expect(headers["X-Initiator"]).toBe("agent")
  state.forceAgent = false // reset
})
