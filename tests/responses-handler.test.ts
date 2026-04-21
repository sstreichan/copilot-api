import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import consola from "consola"
import { Hono } from "hono"
import { stripVTControlCharacters } from "node:util"

import type {
  ResponsesPayload,
  ResponsesResult,
  ResponsesStream,
} from "~/services/copilot/create-responses"

import * as configModule from "~/lib/config"
import * as loggerModule from "~/lib/logger"
import * as rateLimitModule from "~/lib/rate-limit"
import { attachResponseHeaders } from "~/lib/response-headers"
import { state } from "~/lib/state"
import { generateRequestIdFromPayload, getUUID } from "~/lib/utils"
import { handleResponses } from "~/routes/responses/handler"
import * as createResponsesModule from "~/services/copilot/create-responses"

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

const createStreamResponse = (
  chunks: Array<{ event?: string; data?: string }>,
): ResponsesStream =>
  (async function* () {
    for (const chunk of chunks) {
      await Promise.resolve()
      yield chunk
    }
  })() as ResponsesStream

const attachHeaders = <T extends object>(
  value: T,
  headers: Record<string, string>,
): T => attachResponseHeaders(value, new Headers(headers))

const createApp = () => {
  const app = new Hono()
  app.post("/v1/responses", (c) => handleResponses(c))
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
  let getContextModelsSpy: ReturnType<
    typeof spyOn<typeof configModule, "getResponsesApiContextManagementModels">
  >
  let isContextModelSpy: ReturnType<
    typeof spyOn<typeof configModule, "isResponsesApiContextManagementModel">
  >
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
    rateLimitSpy = spyOn(rateLimitModule, "checkRateLimit").mockResolvedValue()
    getConfigSpy = spyOn(configModule, "getConfig").mockReturnValue({
      ...configModule.getConfig(),
      useFunctionApplyPatch: true,
      modelReasoningEfforts: { "gpt-test": "high" },
    })
    resolveEffortSpy = spyOn(
      configModule,
      "resolveEffortForLog",
    ).mockImplementation((requestEffort?: string) =>
      requestEffort ?
        { value: requestEffort, source: "request" as const }
      : { value: "high", source: "config" as const },
    )
    getContextModelsSpy = spyOn(
      configModule,
      "getResponsesApiContextManagementModels",
    ).mockReturnValue([])
    isContextModelSpy = spyOn(
      configModule,
      "isResponsesApiContextManagementModel",
    ).mockReturnValue(false)
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
    rateLimitSpy.mockRestore()
    getConfigSpy.mockRestore()
    resolveEffortSpy.mockRestore()
    getContextModelsSpy.mockRestore()
    isContextModelSpy.mockRestore()
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
      useFunctionApplyPatch: true,
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
    rateLimitSpy = spyOn(rateLimitModule, "checkRateLimit").mockResolvedValue()
    getConfigSpy = spyOn(configModule, "getConfig").mockReturnValue({
      ...configModule.getConfig(),
      useFunctionApplyPatch: true,
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
