import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { Hono } from "hono"

const actualRateLimitModule = await import("../src/lib/rate-limit")

await mock.module("~/lib/rate-limit", () => ({
  ...actualRateLimitModule,
  checkRateLimit: () => {},
}))

import { state } from "../src/lib/state"
import { completionRoutes } from "../src/routes/chat-completions/route"

const originalFetch = globalThis.fetch
const originalState = {
  accountType: state.accountType,
  copilotToken: state.copilotToken,
  lastRequestTimestamp: state.lastRequestTimestamp,
  manualApprove: state.manualApprove,
  models: state.models,
  rateLimitSeconds: state.rateLimitSeconds,
  rateLimitWait: state.rateLimitWait,
  verbose: state.verbose,
  vsCodeVersion: state.vsCodeVersion,
}

const requestUrl = (url: string | URL | Request): string =>
  url instanceof Request ? url.url : url.toString()

const createModelsSessionResponse = () =>
  new Response(
    JSON.stringify({
      available_models: [],
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      session_token: "test-session-token",
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  )

const fetchMock = mock((url: string | URL | Request) => {
  if (requestUrl(url).includes("/models/session")) {
    return Promise.resolve(createModelsSessionResponse())
  }

  return Promise.resolve(
    new Response(
      JSON.stringify({
        id: "chatcmpl-test",
        object: "chat.completion",
        created: 0,
        model: "gpt-test",
        choices: [],
      }),
      {
        status: 200,
        headers: {
          "content-type": "application/json",
          "x-quota-snapshot-premium_interactions":
            "ent=300&ov=0.0&ovPerm=false&rem=35.5&rst=2026-04-01T00%3A00%3A00Z",
        },
      },
    ),
  )
})

const createStreamingFetchMock = () =>
  mock((url: string | URL | Request) => {
    if (requestUrl(url).includes("/models/session")) {
      return Promise.resolve(createModelsSessionResponse())
    }

    return Promise.resolve(
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"))
            controller.close()
          },
        }),
        {
          status: 200,
          headers: {
            "content-type": "text/event-stream",
            "x-usage-ratelimit-session": "rem=5.7&rst=2026-04-21T06%3A35%3A37Z",
          },
        },
      ),
    )
  })

const createModels = () => ({
  object: "list" as const,
  data: [
    {
      capabilities: {
        family: "gpt",
        limits: {},
        object: "model_capabilities" as const,
        supports: {},
        tokenizer: "o200k_base",
        type: "chat" as const,
      },
      id: "gpt-5.4",
      model_picker_enabled: true,
      name: "gpt-5.4",
      object: "model" as const,
      preview: false,
      vendor: "openai",
      version: "1",
    },
  ],
})

const createApp = () => {
  const app = new Hono()
  app.route("/v1/chat/completions", completionRoutes)
  return app
}

beforeEach(() => {
  state.accountType = "individual"
  state.copilotToken = "test-token"
  state.manualApprove = false
  state.verbose = false
  state.vsCodeVersion = "1.0.0"
  state.rateLimitWait = false
  state.rateLimitSeconds = undefined
  state.lastRequestTimestamp = undefined
  state.models = createModels()

  fetchMock.mockClear()
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch =
    fetchMock as unknown as typeof fetch
})

afterEach(() => {
  state.accountType = originalState.accountType
  state.copilotToken = originalState.copilotToken
  state.manualApprove = originalState.manualApprove
  state.verbose = originalState.verbose
  state.vsCodeVersion = originalState.vsCodeVersion
  state.rateLimitWait = originalState.rateLimitWait
  state.rateLimitSeconds = originalState.rateLimitSeconds
  state.lastRequestTimestamp = originalState.lastRequestTimestamp
  state.models = originalState.models
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch = originalFetch
})

describe("chat completions handler", () => {
  test("rejects gpt-5.4 requests with invalid request error", async () => {
    const app = createApp()
    const response = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-5.4",
        messages: [{ role: "user", content: "hello" }],
      }),
    })

    expect(response.status).toBe(400)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test("forwards upstream quota headers on non-stream success", async () => {
    const app = createApp()
    const response = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-test",
        messages: [{ role: "user", content: "hello" }],
      }),
    })

    expect(response.status).toBe(200)
    expect(response.headers.get("x-quota-snapshot-premium_interactions")).toBe(
      "ent=300&ov=0.0&ovPerm=false&rem=35.5&rst=2026-04-01T00%3A00%3A00Z",
    )
  })

  test("forwards upstream rate-limit headers on stream success", async () => {
    const streamingFetchMock = createStreamingFetchMock()
    ;(globalThis as unknown as { fetch: typeof fetch }).fetch =
      streamingFetchMock as unknown as typeof fetch

    const app = createApp()
    const response = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-test",
        stream: true,
        messages: [{ role: "user", content: "hello" }],
      }),
    })

    expect(response.status).toBe(200)
    expect(response.headers.get("x-usage-ratelimit-session")).toBe(
      "rem=5.7&rst=2026-04-21T06%3A35%3A37Z",
    )
  })
})
