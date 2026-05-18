import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test"

const requestMock = mock(() =>
  Promise.resolve({
    statusCode: 200,
    body: {
      text: () => Promise.resolve('{"acc":1}'),
    },
  }),
)

void mock.module("undici", () => ({
  request: requestMock,
}))

// --- Mocks must be set up before importing the module under test ---

// Mock config: default telemetry disabled.
// IMPORTANT: must return a **complete** config shape (including extraPrompts)
// so that other test files sharing this process (e.g. codex tests) still see
// the prompts they depend on via getExtraPromptForModel().
let mockTelemetryEnabled: boolean | undefined = false

const codexToolPrompt = `
## Tool use
- You have access to many tools. If a tool exists to perform a specific task, you MUST use that tool instead of running a terminal command to perform that task.
### Bash tool
When using the Bash tool, follow these rules:
- always run_in_background set to false, unless you are running a long-running command (e.g., a server or a watch command).
### BashOutput tool
When using the BashOutput tool, follow these rules:
- Only Bash Tool run_in_background set to true, Use BashOutput to read the output later
### TodoWrite tool
When using the TodoWrite tool, follow these rules:
- Skip using the TodoWrite tool for tasks with three or fewer steps.
- Do not make single-step todo lists.
- When you made a todo, update it after having performed one of the sub-tasks that you shared on the todo list.
## Special user requests
- If the user makes a simple request (such as asking for the time) which you can fulfill by running a terminal command (such as 'date'), you should do so.
`

function getMockConfig(): {
  telemetry: boolean | undefined
  extraPrompts: Record<string, string>
  smallModel: string
  modelReasoningEfforts: Record<string, string>
  useFunctionApplyPatch: boolean
  compactUseSmallModel: boolean
} {
  return {
    telemetry: mockTelemetryEnabled,
    extraPrompts: {
      "gpt-5-codex": codexToolPrompt,
      "gpt-5.4": "## Intermediary updates",
    },
    smallModel: "gpt-5-mini",
    modelReasoningEfforts: { "gpt-5-mini": "low" },
    useFunctionApplyPatch: true,
    compactUseSmallModel: true,
  }
}

void mock.module("~/lib/config", () => ({
  getConfig: getMockConfig,
  getExtraPromptForModel: (model: string): string =>
    getMockConfig().extraPrompts[model] ?? "",
  getSmallModel: (): string => getMockConfig().smallModel,
  getReasoningEffortForModel: (model: string): string =>
    getMockConfig().modelReasoningEfforts[model] ?? "high",
  shouldCompactUseSmallModel: (): boolean =>
    getMockConfig().compactUseSmallModel,
  mergeConfigWithDefaults: getMockConfig,
}))

import type { TelemetryEnvelope } from "../src/services/telemetry/types"

import { SESSION_ID, getMachineId } from "../src/services/telemetry/identity"
import {
  initTelemetry,
  trackEvent,
  trackRequestSent,
  trackResponseSuccess,
  trackResponseError,
  trackAuthNewToken,
  trackEditFeedback,
  trackEditHunkAction,
  trackPanelRequest,
  scheduleFeedbackEvents,
} from "../src/services/telemetry/telemetry"
import {
  TELEMETRY_IKEY,
  TELEMETRY_ENVELOPE_NAME,
  MSFT_TELEMETRY_API_KEY,
  MSFT_TELEMETRY_ENDPOINT,
  TELEMETRY_SDK_VERSION,
} from "../src/services/telemetry/types"

// Track fetch calls
let fetchCalls: Array<{
  url: string
  options: { method: string; headers: Record<string, string>; body: string }
}> = []
let originalFetch: typeof globalThis.fetch
let originalRandom: typeof Math.random

beforeEach(() => {
  fetchCalls = []
  originalFetch = globalThis.fetch
  originalRandom = Math.random
  Math.random = () => 0.1 // Always pass the 30% sampling gate in trackEvent
  mockTelemetryEnabled = false
  requestMock.mockClear()
})

afterEach(() => {
  globalThis.fetch = originalFetch
  Math.random = originalRandom
  mock.restore()
})

function installFetchMock(
  response?: Partial<Response>,
): ReturnType<typeof mock> {
  const mockFn = mock(
    (
      url: string,
      opts: { method: string; headers: Record<string, string>; body: string },
    ) => {
      fetchCalls.push({ url, options: opts })
      const defaultBody = response ?? { itemsReceived: 1, itemsAccepted: 1 }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve(defaultBody),
        text: () => Promise.resolve(JSON.stringify(defaultBody)),
        ...response,
      })
    },
  )
  globalThis.fetch = mockFn as unknown as typeof fetch
  return mockFn
}

function installFailingFetchMock(): void {
  globalThis.fetch = mock(() =>
    Promise.reject(new Error("network error")),
  ) as unknown as typeof fetch
}

function getFirstEnvelopeFromCall(index = 0): TelemetryEnvelope {
  const call = fetchCalls.at(index)
  if (!call) {
    throw new TypeError(`fetch call not found at index ${index}`)
  }

  const parsed: unknown = JSON.parse(call.options.body)
  if (!Array.isArray(parsed)) {
    throw new TypeError("telemetry body is not an array")
  }

  const first: unknown = parsed.at(0)
  if (typeof first !== "object" || first === null) {
    throw new TypeError("telemetry envelope is missing")
  }

  return first as TelemetryEnvelope
}

/** Extract event names from all captured fetch calls. */
function extractEventNames(calls: typeof fetchCalls): Array<string> {
  return calls.map((c) => {
    const body = JSON.parse(c.options.body) as Array<TelemetryEnvelope>
    return body[0].data.baseData.name
  })
}

function findTelemetryEnvelope(
  eventName: string,
  requestId: string,
): TelemetryEnvelope {
  for (const call of fetchCalls) {
    const body = JSON.parse(call.options.body) as Array<TelemetryEnvelope>
    const match = body.find((env) => {
      return (
        env.data.baseData.name === eventName
        && env.data.baseData.properties.requestId === requestId
      )
    })
    if (match) return match
  }

  throw new TypeError(`${eventName} envelope not found for ${requestId}`)
}

/** Wait for fire-and-forget microtasks to settle */
async function flushMicrotasks(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 20))
}

// ---------------------------------------------------------------------------
// initTelemetry
// ---------------------------------------------------------------------------

describe("telemetry: initTelemetry", () => {
  it("parses tid from copilot token and sets endpoint", () => {
    initTelemetry(
      "tid=abc123;exp=1234567890;sku=monthly",
      "https://custom.endpoint/telemetry",
    )
    mockTelemetryEnabled = true
    installFetchMock()
    trackEvent("test.event", {})

    expect(fetchCalls.length).toBe(1)
    expect(fetchCalls[0].url).toBe("https://custom.endpoint/telemetry")

    const env = getFirstEnvelopeFromCall()
    expect(env.tags["ai.user.id"]).toBe("abc123")
  })
})

// ---------------------------------------------------------------------------
// trackEvent core behaviour
// ---------------------------------------------------------------------------

describe("telemetry: trackEvent", () => {
  it("sends fetch when telemetry is enabled", async () => {
    mockTelemetryEnabled = true
    installFetchMock()
    initTelemetry("tid=user42;exp=999;sku=free")

    trackEvent("copilot-chat/request.sent", { model: "gpt-4" })
    await flushMicrotasks()

    expect(fetchCalls.length).toBe(1)
    expect(fetchCalls[0].options.method).toBe("POST")
    expect(fetchCalls[0].options.headers["Content-Type"]).toBe(
      "application/json",
    )
  })

  it("does NOT send fetch when telemetry is false", () => {
    mockTelemetryEnabled = false
    installFetchMock()

    trackEvent("test.event", { model: "gpt-4" })

    expect(fetchCalls.length).toBe(0)
  })

  it("does NOT send fetch when telemetry field is undefined (default disabled)", () => {
    mockTelemetryEnabled = undefined
    installFetchMock()

    trackEvent("test.event", { model: "gpt-4" })

    expect(fetchCalls.length).toBe(0)
  })

  it("does NOT throw when fetch fails (fire-and-forget)", async () => {
    mockTelemetryEnabled = true
    installFailingFetchMock()

    expect(() => {
      trackEvent("test.event", { model: "gpt-4" })
    }).not.toThrow()

    await flushMicrotasks()
  })

  it("builds correct envelope structure", async () => {
    mockTelemetryEnabled = true
    installFetchMock()
    initTelemetry("tid=envelope-test;exp=1;sku=pro")

    trackEvent(
      "copilot-chat/response.success",
      { model: "gpt-4", status_code: "200" },
      { response_time: 1500 },
    )
    await flushMicrotasks()

    expect(fetchCalls.length).toBe(1)
    const env = getFirstEnvelopeFromCall()
    expect(env.ver).toBe(1)
    expect(env.name).toBe(TELEMETRY_ENVELOPE_NAME)
    expect(env.iKey).toBe(TELEMETRY_IKEY)
    expect(env.sampleRate).toBe(100)
    expect(typeof env.time).toBe("string")

    expect(env.tags["ai.user.id"]).toBe("envelope-test")
    expect(env.tags["ai.session.id"]).toBe(SESSION_ID)
    expect(env.tags["ai.cloud.roleInstance"]).toBe("REDACTED")
    expect(env.tags["ai.internal.sdkVersion"]).toBe(TELEMETRY_SDK_VERSION)

    expect(env.data.baseType).toBe("EventData")
    expect(env.data.baseData.ver).toBe(2)
    expect(env.data.baseData.name).toBe("copilot-chat/response.success")
    expect(env.data.baseData.properties.model).toBe("gpt-4")
    expect(env.data.baseData.properties.status_code).toBe("200")
    expect(env.data.baseData.properties.common_vscodemachineid).toBe(
      getMachineId(),
    )
    expect(env.data.baseData.measurements).toEqual({ response_time: 1500 })
  })
})

// ---------------------------------------------------------------------------
// request / response wrappers
// ---------------------------------------------------------------------------

describe("telemetry: request/response wrappers", () => {
  it("trackRequestSent sends correct event with enhanced properties", async () => {
    mockTelemetryEnabled = true
    installFetchMock()

    trackRequestSent("claude-3.5-sonnet", "individual", "req-abc-123")
    await flushMicrotasks()

    expect(fetchCalls.length).toBe(1)
    const env = getFirstEnvelopeFromCall()
    expect(env.data.baseData.name).toBe("copilot-chat/request.sent")
    const props = env.data.baseData.properties
    expect(props.model).toBe("claude-3.5-sonnet")
    expect(props.accountType).toBe("individual")
    expect(props.endpoint).toBe("completions")
    expect(props.engineName).toBe("chat")
    expect(typeof props.uiKind).toBe("string")
    expect(props.transport).toBe("http")
    expect(props.headerRequestId).toBe("req-abc-123")
    expect(props["request.option.model"]).toBe('"claude-3.5-sonnet"')
    const m = env.data.baseData.measurements
    expect(m).toBeDefined()
    if (!m) throw new TypeError("measurements missing for request.sent")
    expect(m.maxTokenWindow).toBe(128000)
  })

  it("trackResponseSuccess sends correct event with full measurements", async () => {
    mockTelemetryEnabled = true
    installFetchMock()

    trackResponseSuccess({
      model: "gpt-4",
      durationMs: 1234,
      requestId: "req-xyz-789",
      finishReason: "stop",
      promptTokens: 500,
      completionTokens: 300,
      timeToFirstToken: 180,
      bytesReceived: 4096,
    })
    await flushMicrotasks()

    const env = getFirstEnvelopeFromCall()
    expect(env.data.baseData.name).toBe("copilot-chat/response.success")
    const props = env.data.baseData.properties
    expect(props.model).toBe("gpt-4")
    expect(props.modelInvoked).toBe("gpt-4")
    expect(props.reason).toBe("stop")
    expect(props.source).toBe("panel")
    expect(props.initiatorType).toBe("user")
    expect(props.apiType).toBe("chat_completions")
    expect(props.requestId).toBe("req-xyz-789")
    expect(props.transport).toBe("http")
    const m = env.data.baseData.measurements
    expect(m).toBeDefined()
    if (!m) throw new TypeError("measurements missing")
    expect(m.totalTokenMax).toBe(128000)
    expect(m.tokenCountMax).toBe(8192)
    expect(m.promptTokenCount).toBe(500)
    expect(m.completionTokens).toBe(300)
    expect(m.timeToFirstToken).toBe(180)
    expect(m.timeToComplete).toBe(1234)
    expect(m.bytesReceived).toBe(4096)
  })

  it("trackResponseSuccess defaults to zero when optional fields omitted", async () => {
    mockTelemetryEnabled = true
    installFetchMock()

    trackResponseSuccess({ model: "gpt-4", durationMs: 800 })
    await flushMicrotasks()

    const env = getFirstEnvelopeFromCall()
    const m = env.data.baseData.measurements
    expect(m).toBeDefined()
    if (!m) throw new TypeError("measurements missing")
    expect(m.promptTokenCount).toBe(0)
    expect(m.completionTokens).toBe(0)
    expect(m.bytesReceived).toBe(0)
    expect(m.timeToFirstToken).toBe(800)
    expect(env.data.baseData.properties.reason).toBe("stop")
    expect(env.data.baseData.properties.requestId).toBe("")
  })

  it("trackResponseError sends correct event with enhanced properties", async () => {
    mockTelemetryEnabled = true
    installFetchMock()

    trackResponseError({
      model: "gpt-4",
      durationMs: 500,
      statusCode: 429,
      requestId: "req-err-456",
    })
    await flushMicrotasks()

    const env = getFirstEnvelopeFromCall()
    expect(env.data.baseData.name).toBe("copilot-chat/response.error")
    const props = env.data.baseData.properties
    expect(props.model).toBe("gpt-4")
    expect(props.modelInvoked).toBe("gpt-4")
    expect(props.reason).toBe("error")
    expect(props.source).toBe("panel")
    expect(props.initiatorType).toBe("user")
    expect(props.apiType).toBe("chat_completions")
    expect(props.requestId).toBe("req-err-456")
    expect(props.transport).toBe("http")
    const m = env.data.baseData.measurements
    expect(m).toBeDefined()
    if (!m) throw new TypeError("measurements missing")
    expect(m.duration_ms).toBe(500)
    expect(m.status_code).toBe(429)
    expect(m.timeToComplete).toBe(500)
  })

  it("trackAuthNewToken sends correct event", async () => {
    mockTelemetryEnabled = true
    installFetchMock()

    trackAuthNewToken()
    await flushMicrotasks()

    const env = getFirstEnvelopeFromCall()
    expect(env.data.baseData.name).toBe("copilot-chat/auth.new_token")
  })

  it("trackPanelRequest sends OneCollector payload with aria api key", async () => {
    mockTelemetryEnabled = true

    trackPanelRequest({ headerRequestId: "req-panel-001" })
    await flushMicrotasks()

    expect(requestMock).toHaveBeenCalledTimes(1)
    const call = requestMock.mock.calls[0] as Array<unknown> | undefined
    if (!call) {
      throw new TypeError("request call missing")
    }
    const url = call[0]
    const options = call[1]
    if (typeof url !== "string") {
      throw new TypeError("request url missing")
    }
    if (typeof options !== "object" || options === null) {
      throw new TypeError("request options missing")
    }
    expect(url).toBe(MSFT_TELEMETRY_ENDPOINT)
    expect(
      (options as { headers: Record<string, string> }).headers.apikey,
    ).toBe(MSFT_TELEMETRY_API_KEY)

    const payload = JSON.parse((options as { body: string }).body) as {
      name: string
      iKey: string
      data: { baseData: { name: string; properties: Record<string, string> } }
    }
    expect(payload.name).toBe("panel.request")
    expect(payload.iKey.startsWith("o:")).toBe(true)
    expect(payload.data.baseData.name).toBe("panel.request")
    expect(payload.data.baseData.properties.headerRequestId).toBe(
      "req-panel-001",
    )
  })
})

// ---------------------------------------------------------------------------
// feedback wrappers (edit feedback / hunk action / scheduler)
// ---------------------------------------------------------------------------

describe("telemetry: feedback wrappers", () => {
  it("trackEditFeedback sends correct event with properties and measurements", async () => {
    mockTelemetryEnabled = true
    installFetchMock()

    // Mock Math.random to deterministically produce "accepted" (< 0.55)
    const origRandom = Math.random
    Math.random = () => 0.1

    trackEditFeedback("req-feedback-001")

    Math.random = origRandom
    await flushMicrotasks()

    const env = findTelemetryEnvelope(
      "copilot-chat/panel.edit.feedback",
      "req-feedback-001",
    )
    expect(env.data.baseData.name).toBe("copilot-chat/panel.edit.feedback")
    const props = env.data.baseData.properties
    expect(props.requestId).toBe("req-feedback-001")
    expect(props.outcome).toBe("accepted")
    expect(props.hasRemainingEdits).toBe("false")
    expect(typeof props.languageId).toBe("string")
    expect(typeof props.participant).toBe("string")
    expect(typeof props.command).toBe("string")
    const m = env.data.baseData.measurements
    expect(m).toBeDefined()
    if (!m) throw new TypeError("measurements missing")
    expect(m.isNotebook).toBe(0)
    expect(m.isNotebookCell).toBe(0)
  })

  it("trackEditHunkAction sends correct event with line stats", async () => {
    mockTelemetryEnabled = true
    installFetchMock()

    // Mock Math.random to deterministically produce "accepted" (< 0.55)
    const origRandom = Math.random
    Math.random = () => 0.1

    trackEditHunkAction("req-hunk-002")

    Math.random = origRandom
    await flushMicrotasks()

    const env = findTelemetryEnvelope(
      "copilot-chat/edit.hunk.action",
      "req-hunk-002",
    )
    expect(env.data.baseData.name).toBe("copilot-chat/edit.hunk.action")
    const props = env.data.baseData.properties
    expect(props.requestId).toBe("req-hunk-002")
    expect(props.outcome).toBe("accepted")
    expect(typeof props.languageId).toBe("string")
    const m = env.data.baseData.measurements
    expect(m).toBeDefined()
    if (!m) throw new TypeError("measurements missing")
    expect(m.hasRemainingEdits).toBe(0)
    expect(m.isNotebook).toBe(0)
    expect(m.isNotebookCell).toBe(0)
    expect(typeof m.lineCount).toBe("number")
    expect(typeof m.linesAdded).toBe("number")
    expect(typeof m.linesRemoved).toBe("number")
  })

  it("scheduleFeedbackEvents fires both events after delay", async () => {
    mockTelemetryEnabled = true
    installFetchMock()

    // Use object container so TS tracks closure mutations on properties
    const captured: { fn: (() => void) | null; delay: number } = {
      fn: null,
      delay: 0,
    }
    const origTimeout = globalThis.setTimeout

    globalThis.setTimeout = ((fn: () => void, ms: number) => {
      captured.fn = fn
      captured.delay = ms
      return 0 as unknown as ReturnType<typeof setTimeout>
    }) as typeof setTimeout

    // Mock Math.random to pass the 30% gate (< 0.3) and produce "accepted" (< 0.55)
    const origRandom = Math.random
    Math.random = () => 0.1

    scheduleFeedbackEvents("req-sched-003")

    // Restore mocks immediately so they don't leak
    globalThis.setTimeout = origTimeout
    Math.random = origRandom

    // Callback was captured but not yet invoked
    expect(fetchCalls.length).toBe(0)
    expect(captured.fn).not.toBeNull()
    expect(captured.delay).toBeGreaterThanOrEqual(2000)
    expect(captured.delay).toBeLessThanOrEqual(15000)

    // Invoke the callback synchronously, then flush microtasks
    if (!captured.fn) throw new Error("setTimeout callback not captured")
    captured.fn()
    await flushMicrotasks()

    // Assert by event name — immune to cross-test fetch contamination
    const names = extractEventNames(fetchCalls)
    expect(names).toContain("copilot-chat/panel.edit.feedback")
    expect(names).toContain("copilot-chat/edit.hunk.action")
  })

  it("scheduleFeedbackEvents skips when requestId is empty", async () => {
    mockTelemetryEnabled = true
    installFetchMock()

    scheduleFeedbackEvents("")
    await flushMicrotasks()
    expect(fetchCalls.length).toBe(0)
  })
})
