/* eslint-disable @typescript-eslint/no-non-null-assertion */
import {
  test,
  expect,
  mock,
  spyOn,
  beforeEach,
  afterEach,
  describe,
} from "bun:test"

import { state } from "../src/lib/state"
import { createResponses } from "../src/services/copilot/create-responses"
import * as telemetryModule from "../src/services/telemetry/telemetry"

// Mock state
state.copilotToken = "test-token"
state.vsCodeVersion = "1.0.0"
state.accountType = "individual"

// Telemetry mock (captures modelCallId for assertions)
let capturedModelCallId: string | undefined

// Helper: create non-stream fetch mock
const createFetchMock = () =>
  mock((_url: string, opts: { headers: Record<string, string> }) => ({
    ok: true,
    json: () =>
      Promise.resolve({
        id: "resp-123",
        output: [
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "ok" }],
          },
        ],
        usage: { input_tokens: 10, output_tokens: 5 },
        incomplete_details: null,
        error: null,
      }),
    headers: opts.headers,
  }))

// Helper: create stream fetch mock
const createStreamFetchMock = () =>
  mock((_url: string, opts: { headers: Record<string, string> }) => ({
    ok: true,
    body: new ReadableStream(),
    headers: opts.headers,
    [Symbol.asyncIterator]: function* () {},
  }))

// Helper: create error fetch mock
const createErrorFetchMock = (status: number) =>
  mock(() => ({
    ok: false,
    status,
    json: () => Promise.resolve({ error: "upstream error" }),
    headers: {},
    clone: function () {
      return this
    },
  }))

let fetchMock: ReturnType<typeof createFetchMock>

beforeEach(() => {
  state.forceAgent = false
  state.interactionId = "test-interaction-id"
  capturedModelCallId = undefined
  fetchMock = createFetchMock()
  // @ts-expect-error - Mock fetch doesn't implement all fetch properties
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch = fetchMock

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
  mock.restore()
})

// ── X-Initiator tests (原有 3 个测试，保持逻辑不变) ──────────────────────

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
})

// ── Interaction headers tests ─────────────────────────────────────────────

describe("Interaction headers (Wave 1/2)", () => {
  test("includes X-Interaction-Id from state.interactionId", async () => {
    const payload = {
      model: "gpt-test",
      input: [{ role: "user" as const, content: "hi" }],
    }
    await createResponses(payload, { vision: false, initiator: "user" })
    const headers = (
      fetchMock.mock.calls[0][1] as { headers: Record<string, string> }
    ).headers
    expect(headers["X-Interaction-Id"]).toBe("test-interaction-id")
  })

  test("X-Agent-Task-Id equals x-request-id", async () => {
    const payload = {
      model: "gpt-test",
      input: [{ role: "user" as const, content: "hi" }],
    }
    await createResponses(payload, { vision: false, initiator: "user" })
    const headers = (
      fetchMock.mock.calls[0][1] as { headers: Record<string, string> }
    ).headers
    expect(headers["X-Agent-Task-Id"]).toBe(headers["x-request-id"])
  })

  test("X-Interaction-Type equals openai-intent", async () => {
    const payload = {
      model: "gpt-test",
      input: [{ role: "user" as const, content: "hi" }],
    }
    await createResponses(payload, { vision: false, initiator: "user" })
    const headers = (
      fetchMock.mock.calls[0][1] as { headers: Record<string, string> }
    ).headers
    expect(headers["X-Interaction-Type"]).toBe(headers["openai-intent"])
  })

  test("passes non-empty modelCallId to telemetry", async () => {
    const payload = {
      model: "gpt-test",
      input: [{ role: "user" as const, content: "hi" }],
    }
    await createResponses(payload, { vision: false, initiator: "user" })
    expect(capturedModelCallId).toBeDefined()
    expect(typeof capturedModelCallId).toBe("string")
    expect(capturedModelCallId!.length).toBeGreaterThan(0)
  })
})

// ── Stream path ───────────────────────────────────────────────────────────

describe("Stream path", () => {
  test("returns stream when payload.stream is true", async () => {
    // @ts-expect-error - Mock fetch doesn't implement all fetch properties
    ;(globalThis as unknown as { fetch: typeof fetch }).fetch =
      createStreamFetchMock()
    const payload = {
      model: "gpt-test",
      stream: true,
      input: [{ role: "user" as const, content: "hi" }],
    }
    const result = await createResponses(payload, {
      vision: false,
      initiator: "user",
    })
    // events() returns an async iterable
    expect(result).toBeDefined()
  })
})

// ── Error path ────────────────────────────────────────────────────────────

describe("Error path", () => {
  test("throws HTTPError when response is not ok", async () => {
    // @ts-expect-error - Mock fetch doesn't implement all fetch properties
    ;(globalThis as unknown as { fetch: typeof fetch }).fetch =
      createErrorFetchMock(500)
    const payload = {
      model: "gpt-test",
      input: [{ role: "user" as const, content: "hi" }],
    }
    try {
      await createResponses(payload, { vision: false, initiator: "user" })
      expect.unreachable("Should have thrown")
    } catch (error) {
      expect((error as Error).message).toBe("Failed to create responses")
    }
  })
})
