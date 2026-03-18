import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test"
import consola from "consola"
import { Hono } from "hono"

import type { AnthropicMessagesPayload } from "~/routes/messages/anthropic-types"

import * as configModule from "~/lib/config"
import * as rateLimitModule from "~/lib/rate-limit"
import { state } from "~/lib/state"
import {
  getInitiatorFromPayload,
  handleCompletion,
  isClaudeModel,
} from "~/routes/messages/handler"
import * as createMessagesModule from "~/services/copilot/create-messages"

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
    rateLimitSpy = spyOn(rateLimitModule, "checkRateLimit").mockResolvedValue()
    effortSpy = spyOn(
      configModule,
      "getReasoningEffortForModel",
    ).mockReturnValue("xhigh")
  })

  afterEach(() => {
    state.nativeMessages = originalNative
    infoSpy.mockRestore()
    createMessagesSpy.mockRestore()
    rateLimitSpy.mockRestore()
    effortSpy.mockRestore()
  })

  test("logs anthropic effort mapping for config fallback", async () => {
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
    expect(createMessagesSpy).toHaveBeenCalled()

    const infoCall = getFirstInfoCall(infoSpy)
    expect(infoCall).toContain("[effort=max (config)]")
  })
})
