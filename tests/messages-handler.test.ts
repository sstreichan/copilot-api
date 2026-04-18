import type { Context } from "hono"

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import { Hono } from "hono"

import type { AnthropicMessagesPayload } from "../src/routes/messages/anthropic-types"

const actualStateModule = await import("../src/lib/state")
const actualConfigModule = await import("../src/lib/config")
const actualModelsModule = await import("../src/lib/models")
const actualRateLimitModule = await import("../src/lib/rate-limit")
const actualUtilsModule = await import("../src/lib/utils")
const actualApiFlowsModule = await import("../src/routes/messages/api-flows")

const state = actualStateModule.state

let messagesApiEnabled = true
type SelectedModel = {
  id: string
  supported_endpoints?: Array<string>
}

let selectedModel: SelectedModel | undefined
let handlerImportVersion = 0

let handleWithMessagesApiSpy: ReturnType<
  typeof spyOn<typeof actualApiFlowsModule, "handleWithMessagesApi">
>
let handleWithResponsesApiSpy: ReturnType<
  typeof spyOn<typeof actualApiFlowsModule, "handleWithResponsesApi">
>
let handleWithChatCompletionsSpy: ReturnType<
  typeof spyOn<typeof actualApiFlowsModule, "handleWithChatCompletions">
>
let findEndpointModelSpy: ReturnType<
  typeof spyOn<typeof actualModelsModule, "findEndpointModel">
>
let checkRateLimitSpy: ReturnType<
  typeof spyOn<typeof actualRateLimitModule, "checkRateLimit">
>
let getSmallModelSpy: ReturnType<
  typeof spyOn<typeof actualConfigModule, "getSmallModel">
>
let isMessagesApiEnabledSpy: ReturnType<
  typeof spyOn<typeof actualConfigModule, "isMessagesApiEnabled">
>

const createApp = async () => {
  const handlerModule = (await import(
    `../src/routes/messages/handler?messages-handler-test-${++handlerImportVersion}`
  )) as {
    handleCompletion: (c: Context) => Promise<Response>
  }
  const { handleCompletion } = handlerModule
  const app = new Hono()
  app.post("/", handleCompletion)
  return app
}

const createPayload = (
  overrides: Partial<AnthropicMessagesPayload> = {},
): AnthropicMessagesPayload => ({
  model: "original-model",
  max_tokens: 128,
  messages: [{ role: "user", content: "hello" }],
  ...overrides,
})

beforeEach(() => {
  state.manualApprove = false
  state.verbose = false
  messagesApiEnabled = true
  selectedModel = undefined

  handleWithMessagesApiSpy = spyOn(
    actualApiFlowsModule,
    "handleWithMessagesApi",
  ).mockResolvedValue(new Response("messages") as never)
  handleWithResponsesApiSpy = spyOn(
    actualApiFlowsModule,
    "handleWithResponsesApi",
  ).mockResolvedValue(new Response("responses") as never)
  handleWithChatCompletionsSpy = spyOn(
    actualApiFlowsModule,
    "handleWithChatCompletions",
  ).mockResolvedValue(new Response("chat") as never)
  findEndpointModelSpy = spyOn(
    actualModelsModule,
    "findEndpointModel",
  ).mockImplementation((_: string) => selectedModel as never)
  checkRateLimitSpy = spyOn(
    actualRateLimitModule,
    "checkRateLimit",
  ).mockResolvedValue()
  getSmallModelSpy = spyOn(actualConfigModule, "getSmallModel").mockReturnValue(
    "small-model",
  )
  isMessagesApiEnabledSpy = spyOn(
    actualConfigModule,
    "isMessagesApiEnabled",
  ).mockImplementation(() => messagesApiEnabled)
})

afterEach(() => {
  checkRateLimitSpy.mockRestore()
  getSmallModelSpy.mockRestore()
  isMessagesApiEnabledSpy.mockRestore()
  findEndpointModelSpy.mockRestore()
  handleWithMessagesApiSpy.mockRestore()
  handleWithResponsesApiSpy.mockRestore()
  handleWithChatCompletionsSpy.mockRestore()
})

describe("messages handler orchestration", () => {
  test("removes executeCode and rewrites getDiagnostics before forwarding tools", async () => {
    selectedModel = {
      id: "messages-model",
      supported_endpoints: ["/v1/messages"],
    }

    const app = await createApp()
    const response = await app.request("/", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify(
        createPayload({
          tools: [
            {
              name: "mcp__ide__executeCode",
              description: "Execute code in VS Code",
              input_schema: { type: "object" },
            },
            {
              name: "mcp__ide__getDiagnostics",
              description: "Old description",
              input_schema: { type: "object" },
            },
            {
              name: "keep_me",
              description: "Keep me",
              input_schema: { type: "object" },
            },
          ],
        }),
      ),
    })

    expect(response.status).toBe(200)
    expect(await response.text()).toBe("messages")

    const [, forwardedPayload] = handleWithMessagesApiSpy.mock.calls[0]
    expect(forwardedPayload.tools).toEqual([
      {
        name: "mcp__ide__getDiagnostics",
        description:
          "Get language diagnostics from VS Code. Returns errors, warnings, information, and hints for files in the workspace.",
        input_schema: { type: "object" },
      },
      {
        name: "keep_me",
        description: "Keep me",
        input_schema: { type: "object" },
      },
    ])
  })

  test("delegates to the Messages API flow when the model supports /v1/messages", async () => {
    selectedModel = {
      id: "messages-model",
      supported_endpoints: ["/v1/messages"],
    }

    const app = await createApp()
    const response = await app.request("/", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify(createPayload()),
    })

    expect(response.status).toBe(200)
    expect(await response.text()).toBe("messages")
    expect(handleWithMessagesApiSpy).toHaveBeenCalledTimes(1)
    expect(handleWithResponsesApiSpy).not.toHaveBeenCalled()
    expect(handleWithChatCompletionsSpy).not.toHaveBeenCalled()

    const [, forwardedPayload] = handleWithMessagesApiSpy.mock.calls[0]
    expect(forwardedPayload.model).toBe("messages-model")
  })

  test("delegates to the Responses API flow when the model supports /responses", async () => {
    selectedModel = {
      id: "responses-model",
      supported_endpoints: ["/responses"],
    }

    const app = await createApp()
    const response = await app.request("/", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify(createPayload()),
    })

    expect(response.status).toBe(200)
    expect(await response.text()).toBe("responses")
    expect(handleWithMessagesApiSpy).not.toHaveBeenCalled()
    expect(handleWithResponsesApiSpy).toHaveBeenCalledTimes(1)
    expect(handleWithChatCompletionsSpy).not.toHaveBeenCalled()
  })

  test("falls back to the Chat Completions flow when no endpoint matches", async () => {
    selectedModel = {
      id: "chat-model",
      supported_endpoints: [],
    }

    const app = await createApp()
    const response = await app.request("/", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify(createPayload()),
    })

    expect(response.status).toBe(200)
    expect(await response.text()).toBe("chat")
    expect(handleWithMessagesApiSpy).not.toHaveBeenCalled()
    expect(handleWithResponsesApiSpy).not.toHaveBeenCalled()
    expect(handleWithChatCompletionsSpy).toHaveBeenCalledTimes(1)
  })

  test("applies warmup model override and passes request metadata to the selected flow", async () => {
    selectedModel = {
      id: "messages-model",
      supported_endpoints: ["/v1/messages"],
    }

    const payload = createPayload({
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: '<system-reminder>__SUBAGENT_MARKER__{"session_id":"sub-session","agent_id":"agent-1","agent_type":"Explore"}</system-reminder>',
            },
            {
              type: "text",
              text: "hello",
            },
          ],
        },
      ],
    })

    const app = await createApp()
    const response = await app.request("/", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "anthropic-beta": "warmup-beta",
        "x-session-id": "session-123",
      },
      body: JSON.stringify(payload),
    })

    expect(response.status).toBe(200)
    expect(await response.text()).toBe("messages")
    expect(findEndpointModelSpy).toHaveBeenCalledWith("small-model")

    const expectedSessionId = actualUtilsModule.getUUID("session-123")
    const expectedRequestId = actualUtilsModule.generateRequestIdFromPayload(
      payload,
      expectedSessionId,
    )

    const options = handleWithMessagesApiSpy.mock.calls[0][2]
    expect(options.requestId).toBe(expectedRequestId)
    expect(options.sessionId).toBe(expectedSessionId)
    expect(options.subagentMarker).toEqual({
      session_id: "sub-session",
      agent_id: "agent-1",
      agent_type: "Explore",
    })
    expect(options.anthropicBetaHeader).toBe("warmup-beta")
  })
})
