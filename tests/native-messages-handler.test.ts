import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test"
import consola from "consola"
import { Hono } from "hono"
import { stripVTControlCharacters } from "node:util"

import type { AnthropicMessagesPayload } from "~/routes/messages/anthropic-types"

import * as configModule from "~/lib/config"
import * as loggerModule from "~/lib/logger"
import * as modelsModule from "~/lib/models"
import * as rateLimitModule from "~/lib/rate-limit"
import { attachResponseHeaders } from "~/lib/response-headers"
import { state } from "~/lib/state"
import { closeUsageStore } from "~/lib/token-usage"
import { traceIdMiddleware } from "~/lib/trace"
import {
  getInitiatorFromPayload,
  isClaudeModel,
  messagesApiFlowDependencies,
} from "~/routes/messages/api-flows"
import { handleCompletion } from "~/routes/messages/handler"
import { tokenUsageRoute } from "~/routes/token-usage/route"
import * as createMessagesModule from "~/services/copilot/create-messages"

const DB_PATH_ENV = "COPILOT_API_SQLITE_DB_PATH"

const createSseResponse = (events: Array<string>): Response => {
  const encoder = new TextEncoder()

  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const event of events) {
          controller.enqueue(encoder.encode(event))
        }
        controller.close()
      },
    }),
    {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    },
  )
}

const getFirstInfoCall = (
  infoSpy: ReturnType<typeof spyOn<typeof consola, "info">>,
): string => {
  const firstArg: unknown = infoSpy.mock.calls.at(0)?.[0]

  if (typeof firstArg !== "string") {
    throw new TypeError("Expected consola.info to be called with a string")
  }

  return firstArg
}

describe("isClaudeModel", () => {
  test("returns true for claude-sonnet models", () => {
    expect(isClaudeModel("claude-sonnet-4-20250514")).toBe(true)
    expect(isClaudeModel("claude-3-5-sonnet-20241022")).toBe(true)
  })

  test("returns true for claude-opus models", () => {
    expect(isClaudeModel("claude-opus-4-20250514")).toBe(true)
  })

  test("returns true for claude-haiku models", () => {
    expect(isClaudeModel("claude-3-5-haiku-20241022")).toBe(true)
  })

  test("is case-insensitive", () => {
    expect(isClaudeModel("Claude-Sonnet-4")).toBe(true)
    expect(isClaudeModel("CLAUDE-OPUS-4")).toBe(true)
  })

  test("returns false for non-claude models", () => {
    expect(isClaudeModel("gpt-4o")).toBe(false)
    expect(isClaudeModel("gpt-4-turbo")).toBe(false)
    expect(isClaudeModel("o1-preview")).toBe(false)
    expect(isClaudeModel("gemini-pro")).toBe(false)
  })

  test("returns false for models containing claude but not starting with it", () => {
    expect(isClaudeModel("not-claude-model")).toBe(false)
    expect(isClaudeModel("my-claude")).toBe(false)
  })
})

describe("getInitiatorFromPayload", () => {
  test("returns 'user' for empty messages", () => {
    const payload: AnthropicMessagesPayload = {
      model: "claude-sonnet-4-20250514",
      max_tokens: 1024,
      messages: [],
    }
    expect(getInitiatorFromPayload(payload)).toBe("user")
  })

  test("returns 'user' when last message is from user with text content", () => {
    const payload: AnthropicMessagesPayload = {
      model: "claude-sonnet-4-20250514",
      max_tokens: 1024,
      messages: [{ role: "user", content: "Hello" }],
    }
    expect(getInitiatorFromPayload(payload)).toBe("user")
  })

  test("returns 'agent' when last message is from assistant", () => {
    const payload: AnthropicMessagesPayload = {
      model: "claude-sonnet-4-20250514",
      max_tokens: 1024,
      messages: [
        { role: "user", content: "Hello" },
        { role: "assistant", content: "Hi there" },
      ],
    }
    expect(getInitiatorFromPayload(payload)).toBe("agent")
  })

  test("returns 'agent' when last message contains tool_result", () => {
    const payload: AnthropicMessagesPayload = {
      model: "claude-sonnet-4-20250514",
      max_tokens: 1024,
      messages: [
        { role: "user", content: "Use the tool" },
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "call_123",
              name: "my_tool",
              input: { arg: "value" },
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "call_123",
              content: "Tool result here",
            },
          ],
        },
      ],
    }
    expect(getInitiatorFromPayload(payload)).toBe("agent")
  })

  test("returns 'user' when user message has string content after tool_result", () => {
    const payload: AnthropicMessagesPayload = {
      model: "claude-sonnet-4-20250514",
      max_tokens: 1024,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "call_123",
              content: "Tool result",
            },
          ],
        },
        {
          role: "assistant",
          content: "Based on the tool result...",
        },
        {
          role: "user",
          content: "Thanks, now do something else",
        },
      ],
    }
    // Last message is user with string content (not tool_result)
    expect(getInitiatorFromPayload(payload)).toBe("user")
  })

  test("returns 'agent' when user message contains both tool_result and text blocks", () => {
    const payload: AnthropicMessagesPayload = {
      model: "claude-sonnet-4-20250514",
      max_tokens: 1024,
      messages: [
        { role: "user", content: "Call the tool" },
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "call_456",
              name: "read_file",
              input: { path: "/tmp/test.txt" },
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "call_456",
              content: "File contents here",
            },
            {
              type: "text",
              text: "Here is additional context about this file",
            },
          ],
        },
      ],
    }
    // Contains tool_result in array, so should return agent
    expect(getInitiatorFromPayload(payload)).toBe("agent")
  })
})

// eslint-disable-next-line max-lines-per-function
describe("native handler", () => {
  const originalNative = state.nativeMessages
  let infoSpy: ReturnType<typeof spyOn<typeof consola, "info">>
  let createMessagesSpy: ReturnType<
    typeof spyOn<typeof createMessagesModule, "createMessages">
  >
  let rateLimitSpy: ReturnType<
    typeof spyOn<typeof rateLimitModule, "checkRateLimit">
  >
  let effortSpy: ReturnType<
    typeof spyOn<typeof configModule, "getReasoningEffortForModel">
  >
  let getPremiumInfoSpy: ReturnType<
    typeof spyOn<typeof loggerModule, "getPremiumInfo">
  >
  let findEndpointModelSpy: ReturnType<
    typeof spyOn<typeof modelsModule, "findEndpointModel">
  >
  let isMessagesApiEnabledSpy: ReturnType<
    typeof spyOn<typeof configModule, "isMessagesApiEnabled">
  >
  const defaultMessagesApiFlowDependencies = { ...messagesApiFlowDependencies }

  beforeEach(() => {
    state.nativeMessages = true
    infoSpy = spyOn(consola, "info").mockImplementation(((
      ..._args: Parameters<typeof consola.info>
    ) => {}) as typeof consola.info)
    createMessagesSpy = spyOn(
      createMessagesModule,
      "createMessages",
    ).mockResolvedValue(
      new Response(JSON.stringify({ id: "msg-1" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    )
    messagesApiFlowDependencies.createMessages = createMessagesSpy
    getPremiumInfoSpy = spyOn(loggerModule, "getPremiumInfo").mockResolvedValue(
      {
        remaining: 470,
        total: 1500,
      },
    )
    rateLimitSpy = spyOn(rateLimitModule, "checkRateLimit").mockResolvedValue()
    effortSpy = spyOn(
      configModule,
      "getReasoningEffortForModel",
    ).mockReturnValue("xhigh")
    isMessagesApiEnabledSpy = spyOn(
      configModule,
      "isMessagesApiEnabled",
    ).mockReturnValue(true)
    findEndpointModelSpy = spyOn(
      modelsModule,
      "findEndpointModel",
    ).mockReturnValue({
      id: "claude-opus-4",
      name: "claude-opus-4",
      version: "claude-opus-4-20250514",
      object: "model",
      created: 0,
      owned_by: "anthropic",
      capabilities: {
        family: "claude-opus-4",
        type: "chat",
        limits: { max_prompt_tokens: 200000 },
        supports: { adaptive_thinking: false },
      },
      supported_endpoints: ["/v1/messages"],
    } as unknown as ReturnType<typeof modelsModule.findEndpointModel>)
  })

  afterEach(() => {
    state.nativeMessages = originalNative
    infoSpy.mockRestore()
    createMessagesSpy.mockRestore()
    Object.assign(
      messagesApiFlowDependencies,
      defaultMessagesApiFlowDependencies,
    )
    getPremiumInfoSpy.mockRestore()
    rateLimitSpy.mockRestore()
    effortSpy.mockRestore()
    findEndpointModelSpy.mockRestore()
    isMessagesApiEnabledSpy.mockRestore()
  })

  test("logs anthropic effort mapping for config fallback", async () => {
    const app = new Hono()
    app.use("*", traceIdMiddleware)
    app.post("/v1/messages", (c) => handleCompletion(c))

    const res = await app.request("/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "claude-opus-4",
        max_tokens: 1024,
        messages: [{ role: "user", content: "hi" }],
      } satisfies AnthropicMessagesPayload),
    })

    expect(res.status).toBe(200)
    expect(createMessagesSpy).toHaveBeenCalled()

    const infoCall = getFirstInfoCall(infoSpy)
    expect(infoCall).toContain("[effort=max (config)]")
  })

  test("falls back to usage premium info when native response has no attached quota header", async () => {
    const writeSpy = spyOn(process.stdout, "write").mockReturnValue(true)
    const app = new Hono()
    app.post("/v1/messages", (c) => handleCompletion(c))

    const res = await app.request("/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "claude-opus-4",
        max_tokens: 1024,
        messages: [{ role: "user", content: "hi" }],
      } satisfies AnthropicMessagesPayload),
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

  test("native streaming logs a single final left line", async () => {
    const writeSpy = spyOn(process.stdout, "write").mockReturnValue(true)
    createMessagesSpy.mockResolvedValueOnce(
      createSseResponse([
        'event: message_start\ndata: {"type":"message_start"}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hello"}}\n\n',
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      ]),
    )

    const app = new Hono()
    app.post("/v1/messages", (c) => handleCompletion(c))

    const res = await app.request("/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "claude-opus-4",
        stream: true,
        max_tokens: 1024,
        messages: [{ role: "user", content: "hi" }],
      } satisfies AnthropicMessagesPayload),
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
    expect(progressLines[0]).toContain("↪ claude-opus-4 3 ✓ [470 left]")
    expect(getPremiumInfoSpy).toHaveBeenCalledTimes(1)

    writeSpy.mockRestore()
  })

  test("forwards attached upstream headers on native non-stream response", async () => {
    createMessagesSpy.mockResolvedValueOnce(
      attachResponseHeaders(
        new Response(JSON.stringify({ id: "msg-1" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
        new Headers({
          "x-usage-ratelimit-session": "rem=5.7&rst=2026-04-21T06%3A35%3A37Z",
        }),
      ),
    )

    const app = new Hono()
    app.post("/v1/messages", (c) => handleCompletion(c))

    const res = await app.request("/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "claude-opus-4",
        max_tokens: 1024,
        messages: [{ role: "user", content: "hi" }],
      } satisfies AnthropicMessagesPayload),
    })

    expect(res.status).toBe(200)
    expect(res.headers.get("x-usage-ratelimit-session")).toBe(
      "rem=5.7&rst=2026-04-21T06%3A35%3A37Z",
    )
  })

  test("forwards attached upstream headers on native stream response", async () => {
    createMessagesSpy.mockResolvedValueOnce(
      attachResponseHeaders(
        createSseResponse([
          'event: message_start\ndata: {"type":"message_start"}\n\n',
          'event: message_stop\ndata: {"type":"message_stop"}\n\n',
        ]),
        new Headers({
          "x-usage-ratelimit-weekly": "rem=74.9&rst=2026-04-27T00%3A00%3A00Z",
        }),
      ),
    )

    const app = new Hono()
    app.post("/v1/messages", (c) => handleCompletion(c))

    const res = await app.request("/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "claude-opus-4",
        stream: true,
        max_tokens: 1024,
        messages: [{ role: "user", content: "hi" }],
      } satisfies AnthropicMessagesPayload),
    })

    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toContain("text/event-stream")
    expect(res.headers.get("x-usage-ratelimit-weekly")).toBe(
      "rem=74.9&rst=2026-04-27T00%3A00%3A00Z",
    )
  })

  test("records usage from native stream message events", async () => {
    process.env[DB_PATH_ENV] = ":memory:"
    await closeUsageStore()
    createMessagesSpy.mockResolvedValueOnce(
      createSseResponse([
        'event: message_start\ndata: {"type":"message_start","message":{"id":"msg-usage","type":"message","role":"assistant","model":"claude-opus-4","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":37,"output_tokens":1}}}\n\n',
        'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"max_tokens","stop_sequence":null},"usage":{"input_tokens":37,"output_tokens":96}}\n\n',
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      ]),
    )

    const app = new Hono()
    app.post("/v1/messages", (c) => handleCompletion(c))
    app.route("/token-usage", tokenUsageRoute)

    const res = await app.request("/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-session-affinity": "native-stream-test",
        "x-trace-id": "native-stream-usage-test",
      },
      body: JSON.stringify({
        model: "claude-opus-4",
        stream: true,
        max_tokens: 1024,
        messages: [{ role: "user", content: "hi" }],
      } satisfies AnthropicMessagesPayload),
    })

    expect(res.status).toBe(200)
    await res.text()

    const eventsResponse = await app.request(
      "/token-usage/events?period=day&page=1&page_size=10",
    )
    const page = (await eventsResponse.json()) as {
      items: Array<{
        input_tokens: number
        output_tokens: number
        session_id: string
        total_tokens: number
        trace_id: string
      }>
    }

    expect(page.items).toHaveLength(1)
    expect(page.items[0]).toMatchObject({
      input_tokens: 37,
      output_tokens: 96,
      session_id: "native-stream-test",
      total_tokens: 133,
      trace_id: "native-stream-usage-test",
    })

    await closeUsageStore()
    Reflect.deleteProperty(process.env, DB_PATH_ENV)
  })
})
