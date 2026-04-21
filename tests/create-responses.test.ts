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

import { getAttachedPremiumInfo } from "../src/lib/logger"
import { getAttachedResponseHeaders } from "../src/lib/response-headers"
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
  mock((_url: string, opts: { headers: Record<string, string> }) =>
    Promise.resolve({
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
      text: () => Promise.resolve('{"itemsReceived":1,"itemsAccepted":1}'),
      headers: new Headers({
        ...opts.headers,
        "x-quota-snapshot-premium_interactions":
          "ent=300&ov=0.0&ovPerm=false&rem=35.5&rst=2026-04-01T00%3A00%3A00Z",
      }),
    }),
  )

// Helper: create stream fetch mock
const createStreamFetchMock = () =>
  mock((_url: string, opts: { headers: Record<string, string> }) =>
    Promise.resolve({
      ok: true,
      text: () => Promise.resolve('{"itemsReceived":1,"itemsAccepted":1}'),
      body: new ReadableStream(),
      headers: new Headers({
        ...opts.headers,
        "x-quota-snapshot-premium_interactions":
          "ent=300&ov=0.0&ovPerm=false&rem=35.5&rst=2026-04-01T00%3A00%3A00Z",
      }),
      [Symbol.asyncIterator]: function* () {},
    }),
  )

// Helper: create error fetch mock
const createErrorFetchMock = (status: number) =>
  mock(() =>
    Promise.resolve({
      ok: false,
      status,
      json: () => Promise.resolve({ error: "upstream error" }),
      text: () => Promise.resolve('{"itemsReceived":0,"itemsAccepted":0}'),
      headers: {},
      clone: function () {
        return this
      },
    }),
  )

let fetchMock: ReturnType<typeof createFetchMock>
let capturedTrackRequestSentRequestId: string | undefined
let capturedScheduleFeedbackRequestId: string | undefined
let capturedSchedulePostResponseRequestId: string | undefined

beforeEach(() => {
  state.forceAgent = false
  state.interactionId = "test-interaction-id"
  capturedModelCallId = undefined
  capturedTrackRequestSentRequestId = undefined
  capturedScheduleFeedbackRequestId = undefined
  capturedSchedulePostResponseRequestId = undefined
  fetchMock = createFetchMock()
  // @ts-expect-error - Mock fetch doesn't implement all fetch properties
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch = fetchMock

  // Capture modelCallId using spyOn (can be restored by mock.restore())
  spyOn(telemetryModule, "trackRequestSent").mockImplementation(
    (
      _model: string,
      _accountType: string,
      requestId?: string,
      modelCallId?: string,
      // eslint-disable-next-line max-params
    ) => {
      capturedTrackRequestSentRequestId = requestId
      capturedModelCallId = modelCallId
    },
  )
  spyOn(telemetryModule, "trackResponseSuccess").mockImplementation(() => {})
  spyOn(telemetryModule, "trackResponseError").mockImplementation(() => {})
  spyOn(telemetryModule, "trackPanelRequest").mockImplementation(() => {})
  spyOn(telemetryModule, "trackGhostTextShown").mockImplementation(() => {})
  spyOn(telemetryModule, "scheduleFeedbackEvents").mockImplementation(
    (requestId: string) => {
      capturedScheduleFeedbackRequestId = requestId
    },
  )
  spyOn(telemetryModule, "schedulePostResponseEvents").mockImplementation(
    (requestId: string) => {
      capturedSchedulePostResponseRequestId = requestId
    },
  )
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
  expect(headers["x-initiator"]).toBe("user")
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
  expect(headers["x-initiator"]).toBe("agent")
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
  expect(headers["x-initiator"]).toBe("agent")
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
    expect(headers["x-interaction-id"]).toBe("test-interaction-id")
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
    expect(headers["x-agent-task-id"]).toBe(headers["x-request-id"])
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
    expect(headers["x-interaction-type"]).toBe(headers["openai-intent"])
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

  test("uses x-request-id header for telemetry/scheduler when requestId option is missing", async () => {
    const payload = {
      model: "gpt-test",
      input: [{ role: "user" as const, content: "hi" }],
    }

    await createResponses(payload, { vision: false, initiator: "user" })

    const headers = (
      fetchMock.mock.calls[0][1] as { headers: Record<string, string> }
    ).headers
    const headerRequestId = headers["x-request-id"]

    expect(typeof headerRequestId).toBe("string")
    expect(headerRequestId.length).toBeGreaterThan(0)
    expect(capturedTrackRequestSentRequestId).toBe(headerRequestId)
    expect(capturedScheduleFeedbackRequestId).toBe(headerRequestId)
    expect(capturedSchedulePostResponseRequestId).toBe(headerRequestId)
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

  test("attaches premium info from response header on stream path", async () => {
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

    expect(getAttachedPremiumInfo(result)).toEqual({
      remaining: 106.5,
      total: 300,
    })
  })

  test("attaches premium info from response header", async () => {
    const payload = {
      model: "gpt-test",
      input: [{ role: "user" as const, content: "hi" }],
    }

    const result = await createResponses(payload, {
      vision: false,
      initiator: "user",
    })

    expect(getAttachedPremiumInfo(result)).toEqual({
      remaining: 106.5,
      total: 300,
    })
  })

  test("attaches upstream response headers on non-stream path", async () => {
    const payload = {
      model: "gpt-test",
      input: [{ role: "user" as const, content: "hi" }],
    }

    const result = await createResponses(payload, {
      vision: false,
      initiator: "user",
    })

    expect(
      getAttachedResponseHeaders(result)?.get(
        "x-quota-snapshot-premium_interactions",
      ),
    ).toBe("ent=300&ov=0.0&ovPerm=false&rem=35.5&rst=2026-04-01T00%3A00%3A00Z")
  })

  test("attaches upstream response headers on stream path", async () => {
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

    expect(
      getAttachedResponseHeaders(result)?.get(
        "x-quota-snapshot-premium_interactions",
      ),
    ).toBe("ent=300&ov=0.0&ovPerm=false&rem=35.5&rst=2026-04-01T00%3A00%3A00Z")
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
