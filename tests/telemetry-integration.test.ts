import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test"

let mockTelemetryEnabled: boolean | undefined = false

// Complete config shape to prevent cross-test contamination (see telemetry.test.ts)
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

import { state } from "~/lib/state"
import {
  createChatCompletions,
  type ChatCompletionsPayload,
} from "~/services/copilot/create-chat-completions"
import { initTelemetry, trackEvent } from "~/services/telemetry/telemetry"
import { DEFAULT_TELEMETRY_ENDPOINT } from "~/services/telemetry/types"

type FetchCall = {
  url: string
  options?: RequestInit
}

let fetchCalls: Array<FetchCall> = []
let originalFetch: typeof globalThis.fetch
let originalRandom: typeof Math.random

const chatResponse = {
  id: "chat-ok",
  object: "chat.completion",
  created: 0,
  model: "gpt-test",
  choices: [],
}

function jsonResponse(payload: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(payload), {
    status: init?.status ?? 200,
    headers: {
      "content-type": "application/json",
    },
  })
}

function toUrl(input: string | URL | Request): string {
  if (typeof input === "string") return input
  if (input instanceof URL) return input.toString()
  return input.url
}

function installFetchMock(
  handler: (url: string, init?: RequestInit) => Promise<Response>,
): void {
  const mockFn = mock((input: string | URL | Request, init?: RequestInit) => {
    const url = toUrl(input)
    fetchCalls.push({ url, options: init })
    return handler(url, init)
  })

  globalThis.fetch = mockFn as unknown as typeof fetch
}

function telemetryCalls(): Array<FetchCall> {
  return fetchCalls.filter((x) => x.url === DEFAULT_TELEMETRY_ENDPOINT)
}

function parseFirstTelemetryEnvelope(): Record<string, unknown> {
  const call = telemetryCalls().at(0)
  expect(call).toBeDefined()

  const body = call?.options?.body
  expect(typeof body).toBe("string")

  const envelopes = JSON.parse((body ?? "[]") as string) as Array<
    Record<string, unknown>
  >
  const firstEnvelope = envelopes.at(0)
  if (!firstEnvelope) {
    throw new TypeError("telemetry envelope missing")
  }

  return firstEnvelope
}

async function flushMicrotasks(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 20))
}

function buildPayload(): ChatCompletionsPayload {
  return {
    model: "gpt-test",
    messages: [{ role: "user", content: "hello" }],
  }
}

beforeEach(() => {
  fetchCalls = []
  originalFetch = globalThis.fetch
  originalRandom = Math.random
  Math.random = () => 0.1 // Always pass the 30% sampling gate in trackEvent
  mockTelemetryEnabled = false

  state.copilotToken = "test-copilot-token"
  state.githubToken = "test-github-token"
  state.vsCodeVersion = "1.0.0"
  state.accountType = "individual"
  state.forceAgent = false
})

afterEach(() => {
  globalThis.fetch = originalFetch
  Math.random = originalRandom
  mock.restore()
})

describe("telemetry integration with create-chat-completions", () => {
  it("triggers telemetry fetch when config telemetry=true", async () => {
    mockTelemetryEnabled = true
    installFetchMock((url) => {
      if (url === DEFAULT_TELEMETRY_ENDPOINT) {
        return Promise.resolve(
          jsonResponse({ itemsReceived: 1, itemsAccepted: 1 }),
        )
      }
      if (url.includes("/chat/completions")) {
        return Promise.resolve(jsonResponse(chatResponse))
      }
      return Promise.resolve(new Response(null, { status: 404 }))
    })

    const result = await createChatCompletions(buildPayload())
    await flushMicrotasks()

    expect(result).toMatchObject({ id: "chat-ok" })
    expect(fetchCalls.some((x) => x.url.includes("/chat/completions"))).toBe(
      true,
    )
    expect(telemetryCalls().length).toBeGreaterThan(0)
  })

  it("does not trigger telemetry fetch when config telemetry=false", async () => {
    mockTelemetryEnabled = false
    installFetchMock((url) => {
      if (url.includes("/chat/completions")) {
        return Promise.resolve(jsonResponse(chatResponse))
      }
      if (url === DEFAULT_TELEMETRY_ENDPOINT) {
        return Promise.resolve(
          jsonResponse({ itemsReceived: 1, itemsAccepted: 1 }),
        )
      }
      return Promise.resolve(new Response(null, { status: 404 }))
    })

    const result = await createChatCompletions(buildPayload())
    await flushMicrotasks()

    expect(result).toMatchObject({ id: "chat-ok" })
    expect(telemetryCalls().length).toBe(0)
  })

  it("defaults to disabled when config telemetry is undefined", async () => {
    mockTelemetryEnabled = undefined
    installFetchMock((url) => {
      if (url.includes("/chat/completions")) {
        return Promise.resolve(jsonResponse(chatResponse))
      }
      if (url === DEFAULT_TELEMETRY_ENDPOINT) {
        return Promise.resolve(
          jsonResponse({ itemsReceived: 1, itemsAccepted: 1 }),
        )
      }
      return Promise.resolve(new Response(null, { status: 404 }))
    })

    const result = await createChatCompletions(buildPayload())
    await flushMicrotasks()

    expect(result).toMatchObject({ id: "chat-ok" })
    expect(telemetryCalls().length).toBe(0)
  })

  it("does not block main request when telemetry fetch throws (fire-and-forget)", async () => {
    mockTelemetryEnabled = true
    installFetchMock((url) => {
      if (url === DEFAULT_TELEMETRY_ENDPOINT) {
        return Promise.reject(new Error("network error"))
      }
      if (url.includes("/chat/completions")) {
        return Promise.resolve(jsonResponse(chatResponse))
      }
      return Promise.resolve(new Response(null, { status: 404 }))
    })

    const result = await createChatCompletions(buildPayload())
    await flushMicrotasks()

    expect(result).toMatchObject({ id: "chat-ok" })
    expect(fetchCalls.some((x) => x.url.includes("/chat/completions"))).toBe(
      true,
    )
  })

  it("does not block main request when telemetry fetch times out", async () => {
    mockTelemetryEnabled = true
    installFetchMock((url) => {
      if (url === DEFAULT_TELEMETRY_ENDPOINT) {
        const timeoutError = new Error(
          "The operation was aborted due to timeout",
        )
        timeoutError.name = "TimeoutError"
        return Promise.reject(timeoutError)
      }
      if (url.includes("/chat/completions")) {
        return Promise.resolve(jsonResponse(chatResponse))
      }
      return Promise.resolve(new Response(null, { status: 404 }))
    })

    const result = await createChatCompletions(buildPayload())
    await flushMicrotasks()

    expect(result).toMatchObject({ id: "chat-ok" })
    expect(fetchCalls.some((x) => x.url.includes("/chat/completions"))).toBe(
      true,
    )
  })

  it("populates ai.user.id tag when tid is parsed from token", async () => {
    mockTelemetryEnabled = true
    installFetchMock(() =>
      Promise.resolve(jsonResponse({ itemsReceived: 1, itemsAccepted: 1 })),
    )

    initTelemetry("tid=user123;exp=9999999999;sku=monthly_subscriber_v2")
    trackEvent("test.event", { model: "gpt-test" })
    await flushMicrotasks()

    const envelope = parseFirstTelemetryEnvelope()
    const tags = envelope.tags as Record<string, string>
    expect(tags["ai.user.id"]).toBe("user123")
  })

  it("gracefully falls back to empty ai.user.id when tid is missing", async () => {
    mockTelemetryEnabled = true
    installFetchMock(() =>
      Promise.resolve(jsonResponse({ itemsReceived: 1, itemsAccepted: 1 })),
    )

    expect(() => {
      initTelemetry("exp=9999999999;sku=monthly_subscriber_v2")
    }).not.toThrow()

    expect(() => {
      trackEvent("test.event", { model: "gpt-test" })
    }).not.toThrow()

    await flushMicrotasks()

    const envelope = parseFirstTelemetryEnvelope()
    const tags = envelope.tags as Record<string, string>
    expect(tags["ai.user.id"]).toBe("")
  })
})
