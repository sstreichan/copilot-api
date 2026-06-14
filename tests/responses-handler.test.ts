/* eslint-disable max-lines -- comprehensive responses handler coverage; splitting would obscure related scenarios */
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test"
import consola from "consola"
import { Hono } from "hono"
import { StreamingApi } from "hono/utils/stream"
import { stripVTControlCharacters } from "node:util"

import type {
  ResponsesPayload,
  ResponsesResult,
  ResponsesStream,
} from "~/services/copilot/create-responses"

import * as configModule from "~/lib/config"
import { HTTPError } from "~/lib/error"
import * as loggerModule from "~/lib/logger"
import * as rateLimitModule from "~/lib/rate-limit"
import { attachResponseHeaders } from "~/lib/response-headers"
import { state } from "~/lib/state"
import { closeUsageStore } from "~/lib/token-usage"
import { generateRequestIdFromPayload, getUUID } from "~/lib/utils"
import {
  handleResponses,
  responsesHandlerDependencies,
} from "~/routes/responses/handler"
import { responsesUtilsDependencies } from "~/routes/responses/utils"
import { tokenUsageRoute } from "~/routes/token-usage/route"
import * as createChatCompletionsModule from "~/services/copilot/create-chat-completions"
import * as createMessagesModule from "~/services/copilot/create-messages"
import * as createResponsesModule from "~/services/copilot/create-responses"

const defaultResponsesHandlerDependencies = {
  ...responsesHandlerDependencies,
}
const defaultResponsesUtilsDependencies = { ...responsesUtilsDependencies }

const DB_PATH_ENV = "COPILOT_API_SQLITE_DB_PATH"

const isolateTokenUsageStore = async () => {
  process.env[DB_PATH_ENV] = ":memory:"
  await closeUsageStore()
}

const responseResult: ResponsesResult = {
  id: "resp-1",
  object: "response",
  created_at: 0,
  model: "gpt-test",
  output: [],
  output_text: "",
  status: "completed",
  usage: null,
  error: null,
  incomplete_details: null,
  instructions: null,
  metadata: null,
  parallel_tool_calls: false,
  temperature: null,
  tool_choice: null,
  tools: [],
  top_p: null,
}

const createResponsesResult = (model: string): ResponsesResult => ({
  ...structuredClone(responseResult),
  id: "resp-test",
  model,
})

const createPayloadTooLargeError = () =>
  new HTTPError(
    "Failed to create responses",
    new Response(
      JSON.stringify({
        error: { code: "", message: "failed to parse request" },
      }),
      { status: 413 },
    ),
  )

const createStreamResponse = (
  chunks: Array<{ data?: string; event?: string; id?: string }>,
): ResponsesStream =>
  (async function* () {
    for (const chunk of chunks) {
      await Promise.resolve()
      yield chunk
    }
  })() as ResponsesStream

const chatCompletionResponse = {
  id: "chatcmpl-1",
  object: "chat.completion" as const,
  created: 0,
  model: "gemini-2.5-pro",
  choices: [
    {
      index: 0,
      message: {
        role: "assistant" as const,
        content: "Hello from Gemini",
        tool_calls: [] as [],
      },
      finish_reason: "stop" as const,
      logprobs: null,
    },
  ],
  usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
}

const initialState = {
  accountType: state.accountType,
  copilotToken: state.copilotToken,
  lastRequestTimestamp: state.lastRequestTimestamp,
  macMachineId: state.macMachineId,
  manualApprove: state.manualApprove,
  models: state.models,
  rateLimitSeconds: state.rateLimitSeconds,
  rateLimitWait: state.rateLimitWait,
  verbose: state.verbose,
  vsCodeDeviceId: state.vsCodeDeviceId,
  vsCodeSessionId: state.vsCodeSessionId,
  vsCodeVersion: state.vsCodeVersion,
}

const anthropicMessageResponse = {
  id: "msg_123",
  type: "message",
  role: "assistant",
  model: "claude-sonnet-4",
  content: [{ type: "text", text: "Hello from Claude" }],
  stop_reason: "end_turn",
  stop_sequence: null,
  usage: { input_tokens: 12, output_tokens: 7 },
}

const anthropicToolUseResponse = {
  id: "msg_tool",
  type: "message",
  role: "assistant",
  model: "claude-sonnet-4",
  content: [
    { type: "text", text: "Using tool" },
    {
      type: "tool_use",
      id: "toolu_1",
      name: "get_weather",
      input: { city: "Shanghai" },
    },
  ],
  stop_reason: "tool_use",
  stop_sequence: null,
  usage: { input_tokens: 14, output_tokens: 9 },
}

const createAnthropicNativeResponse = (
  body: string,
  init?: ResponseInit,
): Response => new Response(body, init)

const createAnthropicSSEChunks = (events: Array<unknown>): string =>
  events
    .map(
      (event) =>
        `event: ${(event as { type: string }).type}\ndata: ${JSON.stringify(event)}\n\n`,
    )
    .join("")

const attachHeaders = <T extends object>(
  value: T,
  headers: Record<string, string>,
): T => attachResponseHeaders(value, new Headers(headers))

const createApp = () => {
  const app = new Hono()
  app.post("/v1/responses", (c) => handleResponses(c))
  app.route("/token-usage", tokenUsageRoute)
  return app
}

const normalizeInfoCall = (value: string): string =>
  stripVTControlCharacters(value)

const getFirstInfoCall = (
  infoSpy: ReturnType<typeof spyOn<typeof consola, "info">>,
): string => {
  const firstArg: unknown = infoSpy.mock.calls.at(0)?.[0]

  if (typeof firstArg !== "string") {
    throw new TypeError("Expected consola.info to be called with a string")
  }

  return normalizeInfoCall(firstArg)
}

type CreateResponsesOptions = Parameters<
  typeof createResponsesModule.createResponses
>[1]
type AppConfig = configModule.AppConfig

const testModels = {
  object: "list" as const,
  data: [
    {
      id: "gpt-test",
      name: "gpt-test",
      object: "model" as const,
      preview: false,
      model_picker_enabled: true,
      vendor: "copilot",
      version: "1",
      supported_endpoints: ["/responses"],
      capabilities: {
        family: "gpt",
        object: "model" as const,
        supports: { streaming: true },
        tokenizer: "tiktoken",
        type: "text",
        limits: { max_prompt_tokens: 1000 },
      },
    },
    {
      id: "claude-sonnet-4",
      name: "claude-sonnet-4",
      object: "model" as const,
      preview: false,
      model_picker_enabled: true,
      vendor: "anthropic",
      version: "1",
      supported_endpoints: ["/chat/completions", "/v1/messages"],
      capabilities: {
        family: "claude",
        object: "model" as const,
        supports: { streaming: true },
        tokenizer: "claude",
        type: "text",
        limits: { max_prompt_tokens: 128000 },
      },
    },
    {
      id: "gemini-2.5-pro",
      name: "gemini-2.5-pro",
      object: "model" as const,
      preview: false,
      model_picker_enabled: true,
      vendor: "google",
      version: "1",
      supported_endpoints: undefined,
      capabilities: {
        family: "gemini",
        object: "model" as const,
        supports: { streaming: true },
        tokenizer: "tiktoken",
        type: "text",
        limits: { max_prompt_tokens: 100000 },
      },
    },
  ],
}

const defaultConfig = (): AppConfig => ({
  ...configModule.getConfig(),
  modelReasoningEfforts: { "gpt-test": "high" },
})

const postResponses = (payload: Record<string, unknown>) =>
  createApp().request("/v1/responses", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  })

const createRoutingTestSpies = () => {
  const rateLimitSpy = spyOn(
    rateLimitModule,
    "checkRateLimit",
  ).mockResolvedValue()
  const getConfigSpy = spyOn(configModule, "getConfig").mockReturnValue(
    defaultConfig(),
  )
  const createResponsesSpy = spyOn(
    createResponsesModule,
    "createResponses",
  ).mockResolvedValue(responseResult)
  responsesHandlerDependencies.createResponses = createResponsesSpy
  const createChatCompletionsSpy = spyOn(
    createChatCompletionsModule,
    "createChatCompletions",
  ).mockResolvedValue(chatCompletionResponse)
  const createMessagesSpy = spyOn(
    createMessagesModule,
    "createMessages",
  ).mockResolvedValue(
    createAnthropicNativeResponse(JSON.stringify(anthropicMessageResponse)),
  )

  return {
    rateLimitSpy,
    getConfigSpy,
    createResponsesSpy,
    createChatCompletionsSpy,
    createMessagesSpy,
  }
}

const postRoutingRequest = (
  model: string,
  overrides: Record<string, unknown> = {},
) =>
  postResponses({
    model,
    input: [{ role: "user", content: "hi" }],
    ...overrides,
  })

const createPathBStreamResponse = (events: Array<unknown>) =>
  createAnthropicNativeResponse(createAnthropicSSEChunks(events), {
    headers: { "content-type": "text/event-stream" },
  })

const pathBStreamEvents = (): Array<unknown> => [
  {
    type: "message_start",
    message: {
      id: "msg_stream",
      type: "message",
      role: "assistant",
      model: "claude-sonnet-4",
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 0 },
    },
  },
  {
    type: "content_block_start",
    index: 0,
    content_block: { type: "text", text: "" },
  },
  { type: "ping" },
  {
    type: "content_block_delta",
    index: 0,
    delta: { type: "text_delta", text: "Hello" },
  },
  { type: "content_block_stop", index: 0 },
  {
    type: "message_delta",
    delta: { stop_reason: "end_turn", stop_sequence: null },
    usage: { output_tokens: 5 },
  },
  { type: "message_stop" },
]

const pathBStreamErrorEvents = (): Array<unknown> => [
  {
    type: "message_start",
    message: {
      id: "msg_stream_error",
      type: "message",
      role: "assistant",
      model: "claude-sonnet-4",
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 0 },
    },
  },
  { type: "error", error: { type: "api_error", message: "upstream boom" } },
]

const restoreRoutingTestSpies = (
  spies: Partial<ReturnType<typeof createRoutingTestSpies>>,
) => {
  spies.rateLimitSpy?.mockRestore()
  spies.getConfigSpy?.mockRestore()
  spies.createResponsesSpy?.mockRestore()
  spies.createChatCompletionsSpy?.mockRestore()
  spies.createMessagesSpy?.mockRestore()
}

beforeEach(async () => {
  await isolateTokenUsageStore()

  state.copilotToken = "test-token"
  state.accountType = "individual"
  state.macMachineId = "machine-1"
  state.manualApprove = false
  state.verbose = false
  state.rateLimitSeconds = undefined
  state.rateLimitWait = false
  state.lastRequestTimestamp = undefined
  state.vsCodeDeviceId = "device-1"
  state.vsCodeSessionId = "session-1"
  state.vsCodeVersion = "1.120.0"
  state.models = {
    object: "list",
    data: [
      {
        capabilities: {
          limits: {
            max_prompt_tokens: 128000,
          },
        },
        id: "gpt-test",
        supported_endpoints: ["/responses"],
      },
    ],
  } as typeof state.models

  responsesHandlerDependencies.checkRateLimit = async () => {}
  responsesHandlerDependencies.isResponsesApiWebSearchEnabled = () => true
})

afterEach(async () => {
  await closeUsageStore()
  Reflect.deleteProperty(process.env, DB_PATH_ENV)

  state.copilotToken = initialState.copilotToken
  state.accountType = initialState.accountType
  state.macMachineId = initialState.macMachineId
  state.manualApprove = initialState.manualApprove
  state.verbose = initialState.verbose
  state.rateLimitSeconds = initialState.rateLimitSeconds
  state.rateLimitWait = initialState.rateLimitWait
  state.lastRequestTimestamp = initialState.lastRequestTimestamp
  state.vsCodeDeviceId = initialState.vsCodeDeviceId
  state.vsCodeSessionId = initialState.vsCodeSessionId
  state.vsCodeVersion = initialState.vsCodeVersion
  state.models = initialState.models
  Object.assign(
    responsesHandlerDependencies,
    defaultResponsesHandlerDependencies,
  )
  Object.assign(responsesUtilsDependencies, defaultResponsesUtilsDependencies)
})

test("normalizes ANSI-colored info logs before assertions", () => {
  expect(
    normalizeInfoCall(
      "IN \x1b[38;5;165mgpt-test\x1b[0m [effort=high (config)]",
    ),
  ).toBe("IN gpt-test [effort=high (config)]")
})

// eslint-disable-next-line max-lines-per-function
describe("handleResponses reasoning effort", () => {
  const originalModels = state.models
  let receivedPayload: ResponsesPayload | undefined
  let receivedOptions: CreateResponsesOptions | undefined
  let infoSpy: ReturnType<typeof spyOn<typeof consola, "info">>
  let createResponsesSpy: ReturnType<
    typeof spyOn<typeof createResponsesModule, "createResponses">
  >
  let rateLimitSpy: ReturnType<
    typeof spyOn<typeof rateLimitModule, "checkRateLimit">
  >
  let getConfigSpy: ReturnType<typeof spyOn<typeof configModule, "getConfig">>
  let resolveEffortSpy: ReturnType<
    typeof spyOn<typeof configModule, "resolveEffortForLog">
  >
  let getPremiumInfoSpy: ReturnType<
    typeof spyOn<typeof loggerModule, "getPremiumInfo">
  >

  beforeEach(() => {
    state.models = { object: testModels.object, data: [testModels.data[0]] }

    receivedPayload = undefined
    receivedOptions = undefined
    infoSpy = spyOn(consola, "info").mockImplementation(((
      ..._args: Parameters<typeof consola.info>
    ) => {}) as typeof consola.info)
    createResponsesSpy = spyOn(
      createResponsesModule,
      "createResponses",
    ).mockImplementation((payload: ResponsesPayload, options) => {
      receivedPayload = payload
      receivedOptions = options
      return Promise.resolve(responseResult)
    })
    responsesHandlerDependencies.createResponses = createResponsesSpy
    rateLimitSpy = spyOn(rateLimitModule, "checkRateLimit").mockResolvedValue()
    getConfigSpy = spyOn(configModule, "getConfig").mockReturnValue(
      defaultConfig(),
    )
    resolveEffortSpy = spyOn(
      configModule,
      "resolveEffortForLog",
    ).mockImplementation((requestEffort?: string) =>
      requestEffort ?
        { value: requestEffort, source: "request" as const }
      : { value: "high", source: "config" as const },
    )
    getPremiumInfoSpy = spyOn(loggerModule, "getPremiumInfo").mockResolvedValue(
      {
        remaining: 470,
        total: 1500,
      },
    )
  })

  afterEach(() => {
    state.models = originalModels
    infoSpy.mockRestore()
    createResponsesSpy.mockRestore()
    Object.assign(
      responsesHandlerDependencies,
      defaultResponsesHandlerDependencies,
    )
    rateLimitSpy.mockRestore()
    getConfigSpy.mockRestore()
    resolveEffortSpy.mockRestore()
    getPremiumInfoSpy.mockRestore()
  })

  test("fills reasoning effort from config when missing", async () => {
    const app = createApp()

    const res = await app.request("/v1/responses", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-test",
        input: [{ role: "user", content: "hi" }],
      }),
    })

    expect(res.status).toBe(200)
    expect(receivedPayload?.reasoning?.effort).toBe("high")

    const infoCall = getFirstInfoCall(infoSpy)
    expect(infoCall).toContain("IN gpt-test")
    expect(infoCall).toContain("[effort=high (config)]")
  })

  test("keeps request reasoning effort when provided", async () => {
    const app = createApp()

    const res = await app.request("/v1/responses", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-test",
        input: [{ role: "user", content: "hi" }],
        reasoning: { effort: "minimal" },
      }),
    })

    expect(res.status).toBe(200)
    expect(receivedPayload?.reasoning?.effort).toBe("minimal")

    const infoCall = getFirstInfoCall(infoSpy)
    expect(infoCall).toContain("IN gpt-test")
    expect(infoCall).toContain("[effort=minimal (request)]")
  })

  test("keeps web_search tools when config enables them", async () => {
    const app = createApp()

    const webSearchTool = {
      type: "web_search",
      user_location: { type: "approximate", country: "CN" },
    }

    const res = await app.request("/v1/responses", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-test",
        input: [{ role: "user", content: "hi" }],
        tools: [webSearchTool],
      }),
    })

    expect(res.status).toBe(200)
    expect(receivedPayload?.tools).toEqual([webSearchTool])
  })

  test("removes web_search tools when config disables them", async () => {
    getConfigSpy.mockReturnValue({
      ...configModule.getConfig(),
      useResponsesApiWebSearch: false,
      modelReasoningEfforts: { "gpt-test": "high" },
    })

    const app = createApp()

    const res = await app.request("/v1/responses", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-test",
        input: [{ role: "user", content: "hi" }],
        tools: [
          {
            type: "web_search",
          },
          {
            type: "function",
            name: "keep_me",
            parameters: null,
            strict: false,
          },
        ],
      }),
    })

    expect(res.status).toBe(200)
    expect(receivedPayload?.tools).toEqual([
      {
        type: "function",
        name: "keep_me",
        parameters: null,
        strict: false,
      },
    ])
  })

  test("derives stable session identity from prompt_cache_key", async () => {
    const app = createApp()

    const input = [{ role: "user", content: "hi" }]
    const res = await app.request("/v1/responses", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-test",
        input,
        prompt_cache_key: "stable-session-key",
      }),
    })

    const expectedSessionId = getUUID("stable-session-key")

    expect(res.status).toBe(200)
    expect(receivedPayload?.prompt_cache_key).toBe("stable-session-key")
    expect(receivedOptions?.sessionId).toBe(expectedSessionId)
    expect(receivedOptions?.requestId).toBe(
      generateRequestIdFromPayload({ messages: input }, expectedSessionId),
    )
  })

  test("backfills prompt_cache_key from metadata.user_id session marker", async () => {
    const app = createApp()

    const input = [{ role: "user", content: "hi" }]
    const res = await app.request("/v1/responses", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-test",
        input,
        metadata: {
          user_id: "user_demo_account_business_session_session-from-user-id",
        },
      }),
    })

    const expectedSessionId = getUUID("session-from-user-id")

    expect(res.status).toBe(200)
    expect(receivedPayload?.prompt_cache_key).toBe("session-from-user-id")
    expect(receivedOptions?.sessionId).toBe(expectedSessionId)
    expect(receivedOptions?.requestId).toBe(
      generateRequestIdFromPayload({ messages: input }, expectedSessionId),
    )
  })

  test("strips reasoning encrypted_content from direct responses replay input", async () => {
    const app = createApp()

    const res = await app.request("/v1/responses", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-test",
        input: [
          {
            role: "user",
            content: "hello",
          },
          {
            type: "reasoning",
            id: "reasoning-1",
            summary: [{ type: "summary_text", text: "thinking" }],
            encrypted_content: "encrypted",
          },
          {
            type: "message",
            role: "assistant",
            content: [
              {
                type: "output_text",
                text: "answer",
              },
            ],
          },
        ],
      }),
    })

    expect(res.status).toBe(200)
    expect(receivedPayload?.input).toEqual([
      {
        role: "user",
        content: "hello",
      },
      {
        type: "reasoning",
        id: "reasoning-1",
        summary: [{ type: "summary_text", text: "thinking" }],
      },
      {
        type: "message",
        role: "assistant",
        content: [
          {
            type: "output_text",
            text: "answer",
          },
        ],
      },
    ])
  })

  test("falls back to usage premium info when response has no attached quota header", async () => {
    const writeSpy = spyOn(process.stdout, "write").mockReturnValue(true)
    createResponsesSpy.mockResolvedValueOnce(responseResult)

    const app = createApp()
    const res = await app.request("/v1/responses", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-test",
        input: [{ role: "user", content: "hi" }],
      }),
    })

    expect(res.status).toBe(200)
    expect(getPremiumInfoSpy).toHaveBeenCalled()
    expect(
      writeSpy.mock.calls.some((call) =>
        stripVTControlCharacters(String(call[0])).includes("[470 left]"),
      ),
    ).toBe(true)

    writeSpy.mockRestore()
  })

  test("forwards attached upstream headers on non-stream response", async () => {
    createResponsesSpy.mockResolvedValueOnce(
      attachHeaders(structuredClone(responseResult), {
        "x-usage-ratelimit-session": "rem=5.7&rst=2026-04-21T06%3A35%3A37Z",
      }),
    )

    const app = createApp()
    const res = await app.request("/v1/responses", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-test",
        input: [{ role: "user", content: "hi" }],
      }),
    })

    expect(res.status).toBe(200)
    expect(res.headers.get("x-usage-ratelimit-session")).toBe(
      "rem=5.7&rst=2026-04-21T06%3A35%3A37Z",
    )
  })
})

describe("handleResponses streaming logs", () => {
  const originalModels = state.models
  let createResponsesSpy: ReturnType<
    typeof spyOn<typeof createResponsesModule, "createResponses">
  >
  let rateLimitSpy: ReturnType<
    typeof spyOn<typeof rateLimitModule, "checkRateLimit">
  >
  let getConfigSpy: ReturnType<typeof spyOn<typeof configModule, "getConfig">>
  let getPremiumInfoSpy: ReturnType<
    typeof spyOn<typeof loggerModule, "getPremiumInfo">
  >

  beforeEach(() => {
    state.models = {
      object: "list",
      data: [
        {
          id: "gpt-test",
          name: "gpt-test",
          object: "model",
          preview: false,
          model_picker_enabled: true,
          vendor: "copilot",
          version: "1",
          supported_endpoints: ["/responses"],
          capabilities: {
            family: "gpt",
            object: "model",
            supports: { streaming: true },
            tokenizer: "tiktoken",
            type: "text",
            limits: { max_prompt_tokens: 1000 },
          },
        },
      ],
    }

    createResponsesSpy = spyOn(
      createResponsesModule,
      "createResponses",
    ).mockResolvedValue(responseResult)
    responsesHandlerDependencies.createResponses = createResponsesSpy
    rateLimitSpy = spyOn(rateLimitModule, "checkRateLimit").mockResolvedValue()
    getConfigSpy = spyOn(configModule, "getConfig").mockReturnValue({
      ...configModule.getConfig(),
      modelReasoningEfforts: { "gpt-test": "high" },
    })
    getPremiumInfoSpy = spyOn(loggerModule, "getPremiumInfo").mockResolvedValue(
      {
        remaining: 470,
        total: 1500,
      },
    )
  })

  afterEach(() => {
    state.models = originalModels
    createResponsesSpy.mockRestore()
    Object.assign(
      responsesHandlerDependencies,
      defaultResponsesHandlerDependencies,
    )
    rateLimitSpy.mockRestore()
    getConfigSpy.mockRestore()
    getPremiumInfoSpy.mockRestore()
  })

  test("streaming response logs a single final left line", async () => {
    const writeSpy = spyOn(process.stdout, "write").mockReturnValue(true)
    createResponsesSpy.mockResolvedValueOnce(
      createStreamResponse([
        {
          event: "response.created",
          data: JSON.stringify({
            type: "response.created",
            response: {
              id: "resp-1",
              model: "gpt-test",
              output: [],
              status: "in_progress",
            },
          }),
        },
        {
          event: "response.output_item.added",
          data: JSON.stringify({
            type: "response.output_item.added",
            output_index: 0,
            item: {
              type: "message",
              role: "assistant",
              content: [],
            },
          }),
        },
        {
          event: "response.output_text.delta",
          data: JSON.stringify({
            type: "response.output_text.delta",
            output_index: 0,
            content_index: 0,
            item_id: "msg-1",
            delta: "Hello",
          }),
        },
        {
          event: "response.completed",
          data: JSON.stringify({
            type: "response.completed",
            response: {
              id: "resp-1",
              model: "gpt-test",
              output: [],
              output_text: "Hello",
              status: "completed",
            },
          }),
        },
      ]),
    )

    const app = createApp()
    const res = await app.request("/v1/responses", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-test",
        stream: true,
        input: [{ role: "user", content: "hi" }],
      }),
    })

    expect(res.status).toBe(200)
    await res.text()

    const normalizedWrites = writeSpy.mock.calls.map((call) =>
      stripVTControlCharacters(String(call[0])),
    )
    const leftLines = normalizedWrites.filter((value) => value.includes("left"))
    const progressLines = normalizedWrites.filter((value) =>
      value.includes("↪"),
    )

    expect(leftLines).toHaveLength(1)
    expect(progressLines).toHaveLength(1)
    expect(progressLines[0]).toContain("↪ gpt-test 4 ✓ [470 left]")
    expect(getPremiumInfoSpy).toHaveBeenCalledTimes(1)

    writeSpy.mockRestore()
  })

  test("forwards attached upstream headers on stream response", async () => {
    createResponsesSpy.mockResolvedValueOnce(
      attachHeaders(
        createStreamResponse([
          {
            event: "response.completed",
            data: JSON.stringify({
              type: "response.completed",
              response: {
                id: "resp-1",
                model: "gpt-test",
                output: [],
                output_text: "Hello",
                status: "completed",
              },
            }),
          },
        ]),
        {
          "x-usage-ratelimit-weekly": "rem=74.9&rst=2026-04-27T00%3A00%3A00Z",
        },
      ),
    )

    const app = createApp()
    const res = await app.request("/v1/responses", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-test",
        stream: true,
        input: [{ role: "user", content: "hi" }],
      }),
    })

    expect(res.status).toBe(200)
    expect(res.headers.get("x-usage-ratelimit-weekly")).toBe(
      "rem=74.9&rst=2026-04-27T00%3A00%3A00Z",
    )
  })
})

describe("handleResponses 3-level model routing", () => {
  const originalModels = state.models
  let routingSpies: ReturnType<typeof createRoutingTestSpies>

  beforeEach(() => {
    state.models = structuredClone(testModels)
    routingSpies = createRoutingTestSpies()
  })

  afterEach(() => {
    state.models = originalModels
    restoreRoutingTestSpies(routingSpies)
  })

  describe("Path A", () => {
    test("model with /responses endpoint returns 200 (behavior unchanged)", async () => {
      const res = await postRoutingRequest("gpt-test")

      expect(res.status).toBe(200)
      expect(routingSpies.createResponsesSpy).toHaveBeenCalled()
    })
  })

  describe("Path B", () => {
    test("model with /v1/messages endpoint returns ResponsesResult", async () => {
      const res = await postRoutingRequest("claude-sonnet-4")

      expect(res.status).toBe(200)
      const body = (await res.json()) as ResponsesResult
      expect(body.object).toBe("response")
      expect(body.output_text).toBe("Hello from Claude")
      expect(body.status).toBe("completed")
      expect(routingSpies.createMessagesSpy).toHaveBeenCalled()
      expect(routingSpies.createResponsesSpy).not.toHaveBeenCalled()
      expect(routingSpies.createChatCompletionsSpy).not.toHaveBeenCalled()
    })

    test("forwards attached upstream headers on non-stream response", async () => {
      routingSpies.createMessagesSpy.mockResolvedValueOnce(
        attachResponseHeaders(
          createAnthropicNativeResponse(
            JSON.stringify(anthropicMessageResponse),
          ),
          new Headers({
            "x-usage-ratelimit-session": "rem=4.2&rst=2026-04-28T00%3A00%3A00Z",
          }),
        ),
      )

      const res = await postRoutingRequest("claude-sonnet-4")

      expect(res.status).toBe(200)
      expect(res.headers.get("x-usage-ratelimit-session")).toBe(
        "rem=4.2&rst=2026-04-28T00%3A00%3A00Z",
      )
    })

    test("tool_use non-stream is translated into Responses function_call", async () => {
      routingSpies.createMessagesSpy.mockResolvedValueOnce(
        createAnthropicNativeResponse(JSON.stringify(anthropicToolUseResponse)),
      )

      const res = await postResponses({
        model: "claude-sonnet-4",
        input: [{ role: "user", content: "weather" }],
      })

      expect(res.status).toBe(200)
      const body = (await res.json()) as ResponsesResult
      const functionCall = body.output.find(
        (item) => item.type === "function_call",
      )
      expect(functionCall).toBeDefined()
      expect(functionCall).toMatchObject({
        type: "function_call",
        call_id: "toolu_1",
        name: "get_weather",
        arguments: JSON.stringify({ city: "Shanghai" }),
        status: "completed",
      })
    })

    describe("streaming", () => {
      test("returns Responses SSE events", async () => {
        routingSpies.createMessagesSpy.mockResolvedValueOnce(
          createPathBStreamResponse(pathBStreamEvents()),
        )

        const res = await postRoutingRequest("claude-sonnet-4", {
          stream: true,
        })

        expect(res.status).toBe(200)
        const text = await res.text()
        expect(text).toContain("event: response.created")
        expect(text).toContain("event: response.output_text.delta")
        expect(text).toContain("event: response.completed")
        expect(text).not.toContain("event: ping")
      })

      test("ignores [DONE] terminator without emitting response.failed", async () => {
        const sseBody = `${createAnthropicSSEChunks(pathBStreamEvents())}data: [DONE]\n\n`
        routingSpies.createMessagesSpy.mockResolvedValueOnce(
          createAnthropicNativeResponse(sseBody, {
            headers: { "content-type": "text/event-stream" },
          }),
        )

        const res = await postRoutingRequest("claude-sonnet-4", {
          stream: true,
        })

        expect(res.status).toBe(200)
        const text = await res.text()
        expect(text).toContain("event: response.completed")
        expect(text).not.toContain("event: response.failed")
        expect(text).not.toContain("DONE")
      })

      test("errors are mapped to response.failed", async () => {
        routingSpies.createMessagesSpy.mockResolvedValueOnce(
          createPathBStreamResponse(pathBStreamErrorEvents()),
        )

        const res = await postRoutingRequest("claude-sonnet-4", {
          stream: true,
        })

        expect(res.status).toBe(200)
        const text = await res.text()
        expect(text).toContain("event: response.failed")
        expect(text).toContain("upstream boom")
      })
    })

    test("upstream non-stream errors are wrapped in Responses-style envelope", async () => {
      routingSpies.createMessagesSpy.mockRejectedValueOnce(
        new Error("messages backend failed"),
      )

      const res = await postRoutingRequest("claude-sonnet-4")

      expect(res.status).toBe(500)
      const body = (await res.json()) as {
        error: { message: string; type: string }
      }
      expect(body.error).toEqual({
        message: "messages backend failed",
        type: "server_error",
      })
    })
  })

  describe("Path C", () => {
    test("model with undefined endpoints (gemini-2.5-pro) routes to chat fallback", async () => {
      const res = await postRoutingRequest("gemini-2.5-pro")

      expect(res.status).toBe(200)
      expect(routingSpies.createChatCompletionsSpy).toHaveBeenCalled()
      expect(routingSpies.createResponsesSpy).not.toHaveBeenCalled()
      const body = (await res.json()) as {
        id: string
        object: string
        status: string
      }
      expect(body.object).toBe("response")
      expect(body.status).toBe("completed")
    })

    test("gemini non-stream returns ResponsesResult with output_text", async () => {
      const res = await postResponses({
        model: "gemini-2.5-pro",
        input: [{ role: "user", content: "hello" }],
      })

      expect(res.status).toBe(200)
      const body = (await res.json()) as { output_text: string; id: string }
      expect(body.output_text).toBe("Hello from Gemini")
      expect(body.id).toMatch(/^resp_/)
    })
  })

  describe("unknown model", () => {
    test("returns 400 invalid_request_error and skips upstream fetch", async () => {
      const res = await postRoutingRequest("not-a-real-model")

      expect(res.status).toBe(400)
      const body = (await res.json()) as {
        error: { type: string; message: string; code?: string; param?: string }
      }
      expect(body.error.type).toBe("invalid_request_error")
      expect(body.error.message).toContain("not-a-real-model")
      expect(routingSpies.createResponsesSpy).not.toHaveBeenCalled()
      expect(routingSpies.createMessagesSpy).not.toHaveBeenCalled()
      expect(routingSpies.createChatCompletionsSpy).not.toHaveBeenCalled()
    })
  })
})

describe("handleResponses stream cleanup", () => {
  const originalModels = state.models
  let routingSpies: ReturnType<typeof createRoutingTestSpies>
  let closeSpy: ReturnType<typeof spyOn<StreamingApi, "close">>

  beforeEach(() => {
    state.models = structuredClone(testModels)
    routingSpies = createRoutingTestSpies()
    closeSpy = spyOn(StreamingApi.prototype, "close")
  })

  afterEach(() => {
    state.models = originalModels
    restoreRoutingTestSpies(routingSpies)
    closeSpy.mockRestore()
  })

  test("Path A native Responses stream closes the SSE stream in finally", async () => {
    routingSpies.createResponsesSpy.mockResolvedValueOnce(
      createStreamResponse([
        { event: "response.created", data: '{"type":"response.created"}' },
        { event: "response.completed", data: '{"type":"response.completed"}' },
      ]),
    )

    const res = await postRoutingRequest("gpt-test", { stream: true })
    expect(res.status).toBe(200)
    await res.text()
    expect(closeSpy).toHaveBeenCalled()
  })

  test("Path A closes the SSE stream even when upstream iterator throws", async () => {
    const explodingStream = (async function* () {
      yield await Promise.resolve({
        event: "response.created",
        data: '{"type":"response.created"}',
      })
      throw new Error("upstream blew up")
    })() as ResponsesStream
    routingSpies.createResponsesSpy.mockResolvedValueOnce(explodingStream)

    const res = await postRoutingRequest("gpt-test", { stream: true })
    expect(res.status).toBe(200)
    try {
      await res.text()
    } catch {
      // body abort is acceptable; we only care about the close contract
    }
    expect(closeSpy).toHaveBeenCalled()
  })

  test("Path B Anthropic SSE translation closes the SSE stream in finally", async () => {
    routingSpies.createMessagesSpy.mockResolvedValueOnce(
      createPathBStreamResponse(pathBStreamEvents()),
    )

    const res = await postRoutingRequest("claude-sonnet-4", { stream: true })
    expect(res.status).toBe(200)
    await res.text()
    expect(closeSpy).toHaveBeenCalled()
  })

  test("Path B closes the SSE stream when upstream emits an error event", async () => {
    routingSpies.createMessagesSpy.mockResolvedValueOnce(
      createPathBStreamResponse(pathBStreamErrorEvents()),
    )

    const res = await postRoutingRequest("claude-sonnet-4", { stream: true })
    expect(res.status).toBe(200)
    await res.text()
    expect(closeSpy).toHaveBeenCalled()
  })

  test("Path C chat fallback stream closes the SSE stream in finally", async () => {
    routingSpies.createChatCompletionsSpy.mockResolvedValueOnce(
      createStreamResponse([
        {
          data: JSON.stringify({
            id: "chatcmpl-stream",
            object: "chat.completion.chunk",
            created: 0,
            model: "gemini-2.5-pro",
            choices: [
              { index: 0, delta: { content: "hi" }, finish_reason: null },
            ],
          }),
        },
        { data: "[DONE]" },
      ]) as unknown as Awaited<
        ReturnType<typeof createChatCompletionsModule.createChatCompletions>
      >,
    )

    const res = await postRoutingRequest("gemini-2.5-pro", { stream: true })
    expect(res.status).toBe(200)
    await res.text()
    expect(closeSpy).toHaveBeenCalled()
  })
})

describe("responses handler token usage", () => {
  const originalState = {
    copilotToken: state.copilotToken,
    lastRequestTimestamp: state.lastRequestTimestamp,
    manualApprove: state.manualApprove,
    models: state.models,
    rateLimitSeconds: state.rateLimitSeconds,
    rateLimitWait: state.rateLimitWait,
    verbose: state.verbose,
  }
  const createResponsesMock = mock((() =>
    Promise.resolve(
      createStreamResponse([]),
    )) as typeof createResponsesModule.createResponses)
  let createResponsesSpy: ReturnType<
    typeof spyOn<typeof createResponsesModule, "createResponses">
  >
  let getConfigSpy: ReturnType<typeof spyOn<typeof configModule, "getConfig">>

  beforeEach(async () => {
    await isolateTokenUsageStore()

    state.copilotToken = "test-token"
    state.manualApprove = false
    state.verbose = false
    state.rateLimitSeconds = undefined
    state.rateLimitWait = false
    state.lastRequestTimestamp = undefined
    state.models = {
      object: "list",
      data: [testModels.data[0]],
    }

    createResponsesMock.mockClear()
    createResponsesSpy = spyOn(
      createResponsesModule,
      "createResponses",
    ).mockImplementation(createResponsesMock)
    responsesHandlerDependencies.createResponses = createResponsesMock
    getConfigSpy = spyOn(configModule, "getConfig").mockReturnValue(
      defaultConfig(),
    )
  })

  afterEach(async () => {
    createResponsesSpy.mockRestore()
    getConfigSpy.mockRestore()
    await closeUsageStore()
    Reflect.deleteProperty(process.env, DB_PATH_ENV)

    state.copilotToken = originalState.copilotToken
    state.manualApprove = originalState.manualApprove
    state.verbose = originalState.verbose
    state.rateLimitSeconds = originalState.rateLimitSeconds
    state.rateLimitWait = originalState.rateLimitWait
    state.lastRequestTimestamp = originalState.lastRequestTimestamp
    state.models = originalState.models
    Object.assign(
      responsesHandlerDependencies,
      defaultResponsesHandlerDependencies,
    )
    Object.assign(responsesUtilsDependencies, defaultResponsesUtilsDependencies)
  })

  test("uses websocket transport by default for dual-endpoint models", async () => {
    state.models = {
      object: "list",
      data: [
        {
          ...testModels.data[0],
          supported_endpoints: ["/responses", "ws:/responses"],
        },
      ],
    }
    responsesUtilsDependencies.isResponsesApiWebSocketEnabled = () => true
    createResponsesMock.mockImplementation(() =>
      Promise.resolve(structuredClone(responseResult)),
    )

    const app = createApp()
    const response = await app.request("/v1/responses", {
      body: JSON.stringify({ input: "hello", model: "gpt-test" }),
      headers: { "content-type": "application/json" },
      method: "POST",
    })

    expect(response.status).toBe(200)
    expect(createResponsesMock).toHaveBeenCalledTimes(1)
    expect(createResponsesMock.mock.calls[0]?.[1]?.transport).toBe("websocket")
    expect(createResponsesMock.mock.calls[0]?.[1]?.initiator).toBe("user")
    expect(createResponsesMock.mock.calls[0]?.[1]?.subagentMarker).toBeNull()
  })

  test("keeps HTTP transport for dual-endpoint models when websocket is disabled", async () => {
    state.models = {
      object: "list",
      data: [
        {
          ...testModels.data[0],
          supported_endpoints: ["/responses", "ws:/responses"],
        },
      ],
    }
    responsesUtilsDependencies.isResponsesApiWebSocketEnabled = () => false
    createResponsesMock.mockImplementation(() =>
      Promise.resolve(structuredClone(responseResult)),
    )

    const app = createApp()
    const response = await app.request("/v1/responses", {
      body: JSON.stringify({ input: "hello", model: "gpt-test" }),
      headers: { "content-type": "application/json" },
      method: "POST",
    })

    expect(response.status).toBe(200)
    expect(createResponsesMock).toHaveBeenCalledTimes(1)
    expect(createResponsesMock.mock.calls[0]?.[1]?.transport).toBe("http")
  })

  test("keeps HTTP transport when the selected model only supports /responses", async () => {
    createResponsesMock.mockImplementation(() =>
      Promise.resolve(structuredClone(responseResult)),
    )

    const app = createApp()
    const response = await app.request("/v1/responses", {
      body: JSON.stringify({ input: "hello", model: "gpt-test" }),
      headers: { "content-type": "application/json" },
      method: "POST",
    })

    expect(response.status).toBe(200)
    expect(createResponsesMock).toHaveBeenCalledTimes(1)
    expect(createResponsesMock.mock.calls[0]?.[1]?.transport).toBe("http")
  })

  test("uses model Responses API compact threshold before max token fallback", async () => {
    state.models = {
      object: "list",
      data: [
        {
          capabilities: {
            limits: {
              max_prompt_tokens: 128000,
            },
          },
          id: "gpt-threshold-test",
          supported_endpoints: ["/responses"],
        },
      ],
    } as typeof state.models
    responsesUtilsDependencies.getModelResponsesApiCompactThreshold = (
      model,
    ) => (model === "gpt-threshold-test" ? 272_000 * 0.8 : undefined)
    createResponsesMock.mockImplementation((payload) =>
      Promise.resolve(createResponsesResult(payload.model)),
    )

    const app = createApp()
    const response = await app.request("/v1/responses", {
      body: JSON.stringify({
        input: "hello",
        model: "gpt-threshold-test",
      }),
      headers: {
        "content-type": "application/json",
      },
      method: "POST",
    })

    expect(response.status).toBe(200)
    expect(createResponsesMock).toHaveBeenCalledTimes(1)
    expect(createResponsesMock.mock.calls[0][0].context_management).toEqual([
      {
        type: "compaction",
        compact_threshold: 217600,
      },
    ])
  })

  test("does not add context management when input ends with compaction trigger", async () => {
    createResponsesMock.mockImplementation((payload) =>
      Promise.resolve(createResponsesResult(payload.model)),
    )

    const app = createApp()
    const response = await app.request("/v1/responses", {
      body: JSON.stringify({
        input: [
          {
            content: [
              {
                text: "Completed the review for the latest two commits.",
                type: "output_text",
              },
            ],
            phase: "final_answer",
            role: "assistant",
            type: "message",
          },
          {
            type: "compaction_trigger",
          },
        ],
        model: "gpt-test",
      }),
      headers: {
        "content-type": "application/json",
      },
      method: "POST",
    })

    expect(response.status).toBe(200)
    expect(createResponsesMock).toHaveBeenCalledTimes(1)
    expect(
      createResponsesMock.mock.calls[0][0].context_management,
    ).toBeUndefined()
  })

  test("preserves custom apply_patch tools for Copilot Responses", async () => {
    createResponsesMock.mockImplementation((payload: ResponsesPayload) =>
      Promise.resolve({
        ...structuredClone(responseResult),
        model: payload.model,
      }),
    )
    const applyPatchTool = {
      type: "custom",
      name: "apply_patch",
      description: "Edit files with a patch",
      format: {
        type: "grammar",
        syntax: "lark",
        definition: "start: /.+/",
      },
    }

    const app = createApp()
    const response = await app.request("/v1/responses", {
      body: JSON.stringify({
        input: "hello",
        model: "gpt-test",
        tools: [applyPatchTool],
      }),
      headers: {
        "content-type": "application/json",
      },
      method: "POST",
    })

    expect(response.status).toBe(200)
    expect(createResponsesMock).toHaveBeenCalledTimes(1)
    expect(createResponsesMock.mock.calls[0]?.[0].tools?.[0]).toEqual(
      applyPatchTool,
    )
  })

  test("uses Codex subagent headers for Responses request attribution", async () => {
    createResponsesMock.mockImplementation((payload) =>
      Promise.resolve(createResponsesResult(payload.model)),
    )

    const payload = {
      input: [
        {
          content: [{ text: "SUBAGENT_PROBE", type: "input_text" }],
          role: "user",
        },
      ],
      model: "gpt-test",
    }

    const app = createApp()
    const response = await app.request("/v1/responses", {
      body: JSON.stringify(payload),
      headers: {
        "content-type": "application/json",
        "session-id": "root-session",
        "thread-id": "child-thread",
        "x-codex-parent-thread-id": "parent-thread",
        "x-openai-subagent": "collab_spawn",
      },
      method: "POST",
    })

    expect(response.status).toBe(200)
    expect(createResponsesMock).toHaveBeenCalledTimes(1)

    const options = createResponsesMock.mock.calls[0][1]
    const expectedSessionId = getUUID("root-session")
    expect(options?.initiator).toBe("agent")
    expect(options?.sessionId).toBe(expectedSessionId)
    expect(options?.requestId).toBe(
      generateRequestIdFromPayload(
        { messages: payload.input },
        expectedSessionId,
      ),
    )
    expect(options?.subagentMarker).toEqual({
      agent_id: "child-thread",
      agent_type: "collab_spawn",
      session_id: "child-thread",
    })
  })

  test("does not use Codex parent thread header as Responses session", async () => {
    createResponsesMock.mockImplementation((payload) =>
      Promise.resolve(createResponsesResult(payload.model)),
    )

    const payload = {
      input: [
        {
          content: [{ text: "SUBAGENT_PROBE", type: "input_text" }],
          role: "user",
        },
      ],
      model: "gpt-test",
    }

    const app = createApp()
    const response = await app.request("/v1/responses", {
      body: JSON.stringify(payload),
      headers: {
        "content-type": "application/json",
        "session-id": "root-session",
        "x-codex-parent-thread-id": "parent-thread",
        "x-openai-subagent": "collab_spawn",
        "x-session-id": "alternate-session",
      },
      method: "POST",
    })

    expect(response.status).toBe(200)
    expect(createResponsesMock).toHaveBeenCalledTimes(1)

    const options = createResponsesMock.mock.calls[0][1]
    const expectedSessionId = getUUID("root-session")
    expect(options?.initiator).toBe("agent")
    expect(options?.sessionId).toBe(expectedSessionId)
    expect(options?.requestId).toBe(
      generateRequestIdFromPayload(
        { messages: payload.input },
        expectedSessionId,
      ),
    )
    expect(options?.subagentMarker).toEqual({
      agent_id: "parent-thread",
      agent_type: "collab_spawn",
      session_id: "root-session",
    })
  })

  test("ignores session headers when Codex subagent header is missing", async () => {
    createResponsesMock.mockImplementation((payload) =>
      Promise.resolve(createResponsesResult(payload.model)),
    )

    const payload = {
      input: [
        {
          content: [{ text: "hello", type: "input_text" }],
          role: "user",
        },
      ],
      model: "gpt-test",
    }

    const app = createApp()
    const response = await app.request("/v1/responses", {
      body: JSON.stringify(payload),
      headers: {
        "content-type": "application/json",
        "session-id": "root-session",
        "thread-id": "child-thread",
        "x-codex-parent-thread-id": "parent-thread",
      },
      method: "POST",
    })

    expect(response.status).toBe(200)
    expect(createResponsesMock).toHaveBeenCalledTimes(1)

    const options = createResponsesMock.mock.calls[0][1]
    const expectedRequestId = generateRequestIdFromPayload({
      messages: payload.input,
    })
    expect(options?.initiator).toBe("user")
    expect(options?.requestId).toBe(expectedRequestId)
    expect(options?.sessionId).toBe(getUUID(expectedRequestId))
    expect(options?.subagentMarker).toBeNull()
  })

  test("ignores unknown x-openai-subagent values", async () => {
    createResponsesMock.mockImplementation((payload) =>
      Promise.resolve(createResponsesResult(payload.model)),
    )

    const payload = {
      input: [
        {
          content: [{ text: "hello", type: "input_text" }],
          role: "user",
        },
      ],
      model: "gpt-test",
    }

    const app = createApp()
    const response = await app.request("/v1/responses", {
      body: JSON.stringify(payload),
      headers: {
        "content-type": "application/json",
        "session-id": "root-session",
        "thread-id": "child-thread",
        "x-openai-subagent": "unexpected",
      },
      method: "POST",
    })

    expect(response.status).toBe(200)
    expect(createResponsesMock).toHaveBeenCalledTimes(1)
    expect(createResponsesMock.mock.calls[0][1]?.initiator).toBe("user")
    expect(createResponsesMock.mock.calls[0][1]?.subagentMarker).toBeNull()
  })

  test("accepts known Codex subagent header values", async () => {
    for (const agentType of ["compact", "memory_consolidation", "review"]) {
      createResponsesMock.mockReset()
      createResponsesMock.mockImplementation((payload) =>
        Promise.resolve(createResponsesResult(payload.model)),
      )

      const app = createApp()
      const response = await app.request("/v1/responses", {
        body: JSON.stringify({
          input: [
            {
              content: [{ text: "hello", type: "input_text" }],
              role: "user",
            },
          ],
          model: "gpt-test",
        }),
        headers: {
          "content-type": "application/json",
          "session-id": "root-session",
          "thread-id": "child-thread",
          "x-openai-subagent": agentType,
        },
        method: "POST",
      })

      expect(response.status).toBe(200)
      expect(createResponsesMock).toHaveBeenCalledTimes(1)
      expect(createResponsesMock.mock.calls[0][1]?.initiator).toBe("agent")
      expect(createResponsesMock.mock.calls[0][1]?.subagentMarker).toEqual({
        agent_id: "child-thread",
        agent_type: agentType,
        session_id: "child-thread",
      })
    }
  })

  test("omits oversized input images before forwarding to Copilot Responses", async () => {
    state.models = {
      object: "list",
      data: [
        {
          capabilities: {
            limits: {
              max_prompt_tokens: 128000,
              vision: {
                max_prompt_image_size: 8,
              },
            },
          },
          id: "gpt-test",
          supported_endpoints: ["/responses"],
        },
      ],
    } as typeof state.models
    createResponsesMock.mockImplementation((payload) =>
      Promise.resolve(createResponsesResult(payload.model)),
    )

    const app = createApp()
    const response = await app.request("/v1/responses", {
      body: JSON.stringify({
        input: [
          {
            content: [
              { text: "look", type: "input_text" },
              {
                image_url: `data:image/png;base64,${"A".repeat(16)}`,
                type: "input_image",
              },
            ],
            role: "user",
          },
        ],
        model: "gpt-test",
      }),
      headers: {
        "content-type": "application/json",
      },
      method: "POST",
    })

    expect(response.status).toBe(200)
    expect(createResponsesMock).toHaveBeenCalledTimes(1)
    const image = (
      createResponsesMock.mock.calls[0][0].input as Array<{
        content: Array<{
          detail?: string
          image_url?: string
          text?: string
          type: string
        }>
      }>
    )[0].content[1]
    expect(image.type).toBe("input_image")
    expect(image.detail).toBe("low")
    expect(image.image_url?.startsWith("data:image/png;base64,")).toBe(true)
    expect(image.text).toBeUndefined()
  })

  test("preserves multiple input images before forwarding to Copilot Responses", async () => {
    state.models = {
      object: "list",
      data: [
        {
          capabilities: {
            limits: {
              max_prompt_tokens: 128000,
              vision: {
                max_prompt_image_size: 1024,
                max_prompt_images: 1,
              },
            },
          },
          id: "gpt-test",
          supported_endpoints: ["/responses"],
        },
      ],
    } as typeof state.models
    createResponsesMock.mockImplementation((payload) =>
      Promise.resolve(createResponsesResult(payload.model)),
    )

    const firstImageUrl = `data:image/png;base64,${"A".repeat(8)}`
    const secondImageUrl = `data:image/png;base64,${"B".repeat(8)}`

    const app = createApp()
    const response = await app.request("/v1/responses", {
      body: JSON.stringify({
        input: [
          {
            content: [
              { text: "look", type: "input_text" },
              {
                detail: "low",
                image_url: firstImageUrl,
                type: "input_image",
              },
              {
                detail: "low",
                image_url: secondImageUrl,
                type: "input_image",
              },
            ],
            role: "user",
          },
        ],
        model: "gpt-test",
      }),
      headers: {
        "content-type": "application/json",
      },
      method: "POST",
    })

    expect(response.status).toBe(200)
    expect(createResponsesMock).toHaveBeenCalledTimes(1)
    expect(createResponsesMock.mock.calls[0][0].input).toEqual([
      {
        content: [
          { text: "look", type: "input_text" },
          { detail: "low", image_url: firstImageUrl, type: "input_image" },
          { detail: "low", image_url: secondImageUrl, type: "input_image" },
        ],
        role: "user",
      },
    ])
  })

  test("retries once without remaining input images after Copilot rejects payload as too large", async () => {
    state.models = {
      object: "list",
      data: [
        {
          capabilities: {
            limits: {
              max_prompt_tokens: 128000,
              vision: {
                max_prompt_image_size: 1024,
                max_prompt_images: 10,
              },
            },
          },
          id: "gpt-test",
          supported_endpoints: ["/responses"],
        },
      ],
    } as typeof state.models
    createResponsesMock
      .mockImplementationOnce(() =>
        Promise.reject(createPayloadTooLargeError()),
      )
      .mockImplementationOnce((payload) =>
        Promise.resolve(createResponsesResult(payload.model)),
      )

    const app = createApp()
    const imageUrl = `data:image/png;base64,${"A".repeat(8)}`
    const response = await app.request("/v1/responses", {
      body: JSON.stringify({
        input: [
          {
            content: [
              { text: "look", type: "input_text" },
              { detail: "low", image_url: imageUrl, type: "input_image" },
            ],
            role: "user",
          },
        ],
        model: "gpt-test",
      }),
      headers: {
        "content-type": "application/json",
      },
      method: "POST",
    })

    expect(response.status).toBe(200)
    expect(createResponsesMock).toHaveBeenCalledTimes(2)
    const retryImage = (
      createResponsesMock.mock.calls[1][0].input as Array<{
        content: Array<{
          detail?: string
          image_url?: string
          text?: string
          type: string
        }>
      }>
    )[0].content[1]
    expect(retryImage.type).toBe("input_image")
    expect(retryImage.detail).toBe("low")
    expect(retryImage.image_url?.startsWith("data:image/png;base64,")).toBe(
      true,
    )
    expect(retryImage.image_url).not.toBe(imageUrl)
    expect(retryImage.text).toBeUndefined()
    expect(createResponsesMock.mock.calls[1][1]?.vision).toBe(true)
  })

  test("records usage from failed streaming responses and falls back to interaction id", async () => {
    createResponsesMock.mockImplementation(() =>
      Promise.resolve(
        createStreamResponse([
          {
            data: JSON.stringify({
              response: {
                created_at: 0,
                error: { message: "request failed" },
                id: "resp_123",
                incomplete_details: null,
                instructions: null,
                metadata: null,
                model: "gpt-test",
                object: "response",
                output: [],
                output_text: "",
                parallel_tool_calls: false,
                status: "failed",
                temperature: null,
                tool_choice: "auto",
                tools: [],
                top_p: null,
                usage: {
                  input_tokens: 5,
                  input_tokens_details: { cached_tokens: 1 },
                  output_tokens: 2,
                  total_tokens: 7,
                },
              },
              sequence_number: 1,
              type: "response.failed",
            }),
            event: "response.failed",
          },
        ]),
      ),
    )

    const app = createApp()
    const payload = {
      input: "hello",
      model: "gpt-test",
      stream: true,
    }
    const response = await app.request("/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    })

    expect(response.status).toBe(200)
    await response.text()

    const eventsResponse = await app.request(
      "/token-usage/events?period=day&page=1&page_size=10",
    )
    expect(eventsResponse.status).toBe(200)

    const page = (await eventsResponse.json()) as {
      items: Array<{
        cache_read_input_tokens: number
        input_tokens: number
        output_tokens: number
        session_id: string
        total_tokens: number
      }>
    }
    expect(page.items).toHaveLength(1)

    const expectedRequestId = generateRequestIdFromPayload({
      messages: payload.input,
    })
    const expectedInteractionId = getUUID(expectedRequestId)

    expect(page.items[0]?.session_id).toBe(expectedInteractionId)
    expect(page.items[0]?.cache_read_input_tokens).toBe(1)
    expect(page.items[0]?.input_tokens).toBe(4)
    expect(page.items[0]?.output_tokens).toBe(2)
    expect(page.items[0]?.total_tokens).toBe(7)
  })
})
