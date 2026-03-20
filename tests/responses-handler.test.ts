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
import { state } from "~/lib/state"
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

test("normalizes ANSI-colored info logs before assertions", () => {
  expect(
    normalizeInfoCall(
      "IN \x1b[38;5;165mgpt-test\x1b[0m [effort=high (config)]",
    ),
  ).toBe("IN gpt-test [effort=high (config)]")
})

describe("handleResponses reasoning effort", () => {
  const originalModels = state.models
  let receivedPayload: ResponsesPayload | undefined
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
    infoSpy = spyOn(consola, "info").mockImplementation(((
      ..._args: Parameters<typeof consola.info>
    ) => {}) as typeof consola.info)
    createResponsesSpy = spyOn(
      createResponsesModule,
      "createResponses",
    ).mockImplementation((payload: ResponsesPayload) => {
      receivedPayload = payload
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
})
