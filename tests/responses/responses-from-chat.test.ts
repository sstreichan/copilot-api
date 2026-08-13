import { describe, expect, it } from "bun:test"

import type { ResponsesPayload } from "~/lib/types/responses"

import { translateResponsesToChatCompletions } from "~/routes/responses/responses-from-chat"

describe("translateResponsesToChatCompletions", () => {
  it("maps instructions, messages, tool pairs, tools, and reasoning effort to chat payload", () => {
    const payload: ResponsesPayload = {
      model: "gpt-4.1",
      instructions: "Follow the project rules.",
      input: [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "What is the weather?" }],
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
          type: "reasoning",
          summary: [{ type: "summary_text", text: "Need weather lookup." }],
          encrypted_content: "opaque-reasoning",
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
      tool_choice: { type: "function", name: "lookup_weather" },
      reasoning: { effort: "high", summary: "detailed" },
      temperature: 0.2,
      top_p: 0.9,
      max_output_tokens: 1024,
      stream: false,
      parallel_tool_calls: true,
      metadata: { user_id: "user-1" },
    }

    const result = translateResponsesToChatCompletions(payload)

    expect(result).toEqual({
      model: "gpt-4.1",
      messages: [
        { role: "system", content: "Follow the project rules." },
        {
          role: "user",
          content: [{ type: "text", text: "What is the weather?" }],
        },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_weather",
              type: "function",
              function: {
                name: "lookup_weather",
                arguments: '{"city":"Hangzhou"}',
              },
            },
          ],
        },
        {
          role: "tool",
          tool_call_id: "call_weather",
          content: "Sunny",
        },
        {
          role: "assistant",
          content: [{ type: "text", text: "It is sunny." }],
        },
      ],
      tools: [
        {
          type: "function",
          function: {
            name: "lookup_weather",
            description: "Looks up weather.",
            parameters: {
              type: "object",
              properties: { city: { type: "string" } },
              required: ["city"],
            },
          },
        },
      ],
      tool_choice: {
        type: "function",
        function: { name: "lookup_weather" },
      },
      reasoning_effort: "high",
      temperature: 0.2,
      top_p: 0.9,
      max_tokens: 1024,
      stream: false,
      user: "user-1",
    })
  })

  it("maps string input into a user chat message and omits blank instructions", () => {
    const result = translateResponsesToChatCompletions({
      model: "gpt-4.1",
      instructions: "   ",
      input: "hello",
    })

    expect(result.messages).toEqual([{ role: "user", content: "hello" }])
    expect(result).not.toHaveProperty("reasoning_effort")
  })

  it("maps message input items that omit the optional type field", () => {
    const result = translateResponsesToChatCompletions({
      model: "gpt-4.1",
      input: [{ role: "user", content: "hello without explicit type" }],
    })

    expect(result.messages).toEqual([
      { role: "user", content: "hello without explicit type" },
    ])
  })

  it("drops unsupported content blocks instead of inventing chat content", () => {
    const result = translateResponsesToChatCompletions({
      model: "gpt-4.1",
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
            { type: "input_text", text: "describe only the text" },
            {
              type: "input_file",
              file_data: "data:application/pdf;base64,abc",
            },
          ],
        },
      ],
    })

    expect(result.messages).toEqual([
      {
        role: "user",
        content: [{ type: "text", text: "describe only the text" }],
      },
    ])
  })
})
