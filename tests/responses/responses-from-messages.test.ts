import { describe, expect, it } from "bun:test"

import type { ResponsesPayload } from "~/services/copilot/create-responses"

import {
  createAnthropicToResponsesStreamState,
  translateAnthropicMessageToResponses,
  translateAnthropicStreamEventToResponsesStreamEvents,
  translateResponsesToAnthropicMessages,
} from "~/routes/responses/responses-from-messages"

describe("translateResponsesToAnthropicMessages", () => {
  it("maps instructions, supported input items, function tools, tool choice, and reasoning effort", () => {
    const payload: ResponsesPayload = {
      model: "claude-sonnet-4.6",
      instructions: "Follow the project rules.",
      input: [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "What is the weather?" }],
        },
        {
          type: "reasoning",
          id: "rs_123",
          summary: [{ type: "summary_text", text: "Need a weather lookup." }],
          encrypted_content: "opaque-reasoning",
        },
        {
          type: "function_call",
          call_id: "call_weather",
          name: "lookup_weather",
          arguments: '{"city":"Hangzhou"}',
          status: "completed",
        },
        {
          type: "function_call_output",
          call_id: "call_weather",
          output: "Sunny",
          status: "completed",
        },
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "It is sunny." }],
        },
        {
          type: "custom_unsupported",
          value: true,
        },
      ],
      tools: [
        {
          type: "function",
          name: "lookup_weather",
          description: "Looks up weather.",
          parameters: {
            type: "object",
            properties: { city: { type: "string" } },
            required: ["city"],
          },
          strict: false,
        },
        {
          type: "web_search",
          name: "search",
        },
      ],
      tool_choice: "required",
      reasoning: { effort: "xhigh", summary: "detailed" },
      temperature: 0.2,
      top_p: 0.9,
      max_output_tokens: 1024,
      stream: false,
      metadata: { user_id: "user-1" },
    }

    const result = translateResponsesToAnthropicMessages(payload)

    expect(result).toEqual({
      model: "claude-sonnet-4.6",
      max_tokens: 1024,
      system: "Follow the project rules.",
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "What is the weather?" }],
        },
        {
          role: "assistant",
          content: [
            {
              type: "thinking",
              thinking: "Need a weather lookup.",
              signature: "opaque-reasoning@rs_123",
            },
            {
              type: "tool_use",
              id: "call_weather",
              name: "lookup_weather",
              input: { city: "Hangzhou" },
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "call_weather",
              content: "Sunny",
            },
          ],
        },
        {
          role: "assistant",
          content: [{ type: "text", text: "It is sunny." }],
        },
      ],
      tools: [
        {
          name: "lookup_weather",
          description: "Looks up weather.",
          input_schema: {
            type: "object",
            properties: { city: { type: "string" } },
            required: ["city"],
          },
        },
      ],
      tool_choice: { type: "any" },
      output_config: { effort: "xhigh" },
      temperature: 0.2,
      top_p: 0.9,
      stream: false,
      metadata: { user_id: "user-1" },
    })
  })

  it("maps string input and omits blank instructions", () => {
    const result = translateResponsesToAnthropicMessages({
      model: "claude-sonnet-4.6",
      instructions: "   ",
      input: "hello",
    })

    expect(result.messages).toEqual([{ role: "user", content: "hello" }])
    expect(result).not.toHaveProperty("system")
    expect(result.max_tokens).toBeGreaterThan(0)
  })

  it("maps auto and function tool choices to Anthropic-compatible choices", () => {
    expect(
      translateResponsesToAnthropicMessages({
        model: "claude-sonnet-4.6",
        input: "hi",
        tool_choice: "auto",
      }).tool_choice,
    ).toEqual({ type: "auto" })

    expect(
      translateResponsesToAnthropicMessages({
        model: "claude-sonnet-4.6",
        input: "hi",
        tool_choice: { type: "function", name: "lookup_weather" },
      }).tool_choice,
    ).toEqual({ type: "tool", name: "lookup_weather" })
  })

  it("maps input_image data URLs and drops unsupported input items", () => {
    const result = translateResponsesToAnthropicMessages({
      model: "claude-sonnet-4.6",
      input: [
        {
          type: "message",
          role: "user",
          content: [
            {
              type: "input_image",
              image_url: "data:image/png;base64,abc",
              detail: "auto",
            },
            { type: "input_text", text: "describe only this text" },
            {
              type: "input_file",
              file_data: "data:application/pdf;base64,abc",
            },
          ],
        },
        { type: "unsupported_item", text: "do not leak" },
      ],
    })

    expect(result.messages).toEqual([
      {
        role: "user",
        content: [
          {
            type: "image",
            source: {
              type: "base64",
              media_type: "image/png",
              data: "abc",
            },
          },
          { type: "text", text: "describe only this text" },
        ],
      },
    ])
  })
})
describe("translateResponsesToAnthropicMessages replay tool results", () => {
  it("merges assistant text before tool calls into one assistant message", () => {
    const result = translateResponsesToAnthropicMessages({
      model: "claude-sonnet-4.6",
      input: [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "inspect git status" }],
        },
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "I will inspect it." }],
        },
        {
          type: "function_call",
          call_id: "call_status",
          name: "exec_command",
          arguments: '{"cmd":"git status --short"}',
          status: "completed",
        },
        {
          type: "function_call_output",
          call_id: "call_status",
          output: "M src/file.ts",
          status: "completed",
        },
      ],
    })

    expect(result.messages).toEqual([
      {
        role: "user",
        content: [{ type: "text", text: "inspect git status" }],
      },
      {
        role: "assistant",
        content: [
          { type: "text", text: "I will inspect it." },
          {
            type: "tool_use",
            id: "call_status",
            name: "exec_command",
            input: { cmd: "git status --short" },
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "call_status",
            content: "M src/file.ts",
          },
        ],
      },
    ])
  })
})
describe("translateAnthropicMessageToResponses", () => {
  it("maps text, thinking, and tool_use blocks into Responses output items and normalized usage", () => {
    const result = translateAnthropicMessageToResponses({
      id: "msg_123",
      type: "message",
      role: "assistant",
      model: "claude-sonnet-4.6",
      content: [
        { type: "text", text: "Need to inspect the weather." },
        {
          type: "thinking",
          thinking: "I should call the weather tool.",
          signature: "opaque-signature@rs_123",
        },
        {
          type: "tool_use",
          id: "toolu_123",
          name: "lookup_weather",
          input: { city: "Hangzhou" },
        },
      ],
      copilot_usage: {
        total_nano_aiu: 123,
      },
      stop_reason: "tool_use",
      stop_sequence: null,
      usage: {
        input_tokens: 120,
        output_tokens: 80,
        cache_read_input_tokens: 20,
      },
    })

    expect(result.created_at).toEqual(expect.any(Number) as unknown as number)
    expect(result).toMatchObject({
      id: "msg_123",
      object: "response",
      model: "claude-sonnet-4.6",
      output: [
        {
          id: "msg_123_msg_0",
          type: "message",
          role: "assistant",
          status: "completed",
          content: [
            {
              type: "output_text",
              text: "Need to inspect the weather.",
              annotations: [],
            },
          ],
        },
        {
          id: "rs_123",
          type: "reasoning",
          summary: [
            { type: "summary_text", text: "I should call the weather tool." },
          ],
          encrypted_content: "opaque-signature",
          status: "completed",
        },
        {
          id: "fc_toolu_123",
          type: "function_call",
          call_id: "toolu_123",
          name: "lookup_weather",
          arguments: '{"city":"Hangzhou"}',
          status: "completed",
        },
      ],
      output_text: "Need to inspect the weather.",
      status: "completed",
      usage: {
        input_tokens: 120,
        output_tokens: 80,
        total_tokens: 200,
        input_tokens_details: {
          cached_tokens: 20,
        },
      },
      error: null,
      incomplete_details: null,
      instructions: null,
      metadata: null,
      parallel_tool_calls: true,
      temperature: null,
      tool_choice: "auto",
      tools: [],
      top_p: null,
      copilot_usage: {
        total_nano_aiu: 123,
      },
    })
  })

  it("maps refusal into an incomplete message output item with content_filter reason", () => {
    const result = translateAnthropicMessageToResponses({
      id: "msg_refusal",
      type: "message",
      role: "assistant",
      model: "claude-sonnet-4.6",
      content: [{ type: "text", text: "I can't help with that request." }],
      stop_reason: "refusal",
      stop_sequence: null,
      usage: {
        input_tokens: 25,
        output_tokens: 5,
      },
    })

    expect(result.status).toBe("incomplete")
    expect(result.incomplete_details).toEqual({ reason: "content_filter" })
    expect(result.output).toEqual([
      {
        id: "msg_refusal_msg_0",
        type: "message",
        role: "assistant",
        status: "incomplete",
        content: [
          {
            type: "refusal",
            refusal: "I can't help with that request.",
          },
        ],
      },
    ])
    expect(result.output_text).toBe("")
  })

  it("maps max_tokens into incomplete max_output_tokens details and preserves output text", () => {
    const result = translateAnthropicMessageToResponses({
      id: "msg_max",
      type: "message",
      role: "assistant",
      model: "claude-sonnet-4.6",
      content: [{ type: "text", text: "Partial answer" }],
      stop_reason: "max_tokens",
      stop_sequence: null,
      usage: {
        input_tokens: 40,
        output_tokens: 15,
      },
    })

    expect(result.status).toBe("incomplete")
    expect(result.incomplete_details).toEqual({ reason: "max_output_tokens" })
    expect(result.output_text).toBe("Partial answer")
    expect(result.output).toEqual([
      {
        id: "msg_max_msg_0",
        type: "message",
        role: "assistant",
        status: "incomplete",
        content: [
          {
            type: "output_text",
            text: "Partial answer",
            annotations: [],
          },
        ],
      },
    ])
  })

  it("drops unsupported assistant blocks conservatively", () => {
    const result = translateAnthropicMessageToResponses({
      id: "msg_redacted",
      type: "message",
      role: "assistant",
      model: "claude-sonnet-4.6",
      content: [{ type: "redacted_thinking", data: "opaque" }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: {
        input_tokens: 10,
        output_tokens: 0,
      },
    })

    expect(result.output).toEqual([])
    expect(result.output_text).toBe("")
    expect(result.status).toBe("completed")
  })
})

describe("translateAnthropicStreamEventToResponsesStreamEvents", () => {
  it("carries copilot_usage into response.completed for messages backend streams", () => {
    const state = createAnthropicToResponsesStreamState()

    translateAnthropicStreamEventToResponsesStreamEvents(
      {
        type: "message_start",
        message: {
          id: "msg_stream",
          type: "message",
          role: "assistant",
          model: "claude-sonnet-4.6",
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: {
            input_tokens: 10,
            output_tokens: 0,
          },
        },
      },
      state,
    )

    translateAnthropicStreamEventToResponsesStreamEvents(
      {
        type: "message_delta",
        delta: {
          stop_reason: "end_turn",
          stop_sequence: null,
        },
        usage: {
          output_tokens: 5,
        },
        copilot_usage: {
          total_nano_aiu: 456,
        },
      },
      state,
    )

    const events = translateAnthropicStreamEventToResponsesStreamEvents(
      {
        type: "message_stop",
      },
      state,
    )

    expect(events.at(-1)).toMatchObject({
      type: "response.completed",
      response: {
        copilot_usage: {
          total_nano_aiu: 456,
        },
      },
    })
  })
})
