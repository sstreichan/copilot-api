import { describe, expect, it } from "bun:test"

import type { ChatCompletionChunk } from "~/services/copilot/create-chat-completions"

import {
  createChatCompletionToResponsesStreamState,
  translateChatCompletionChunkToResponsesStreamEvents,
  translateChatCompletionStreamErrorToResponsesEvent,
} from "~/routes/responses/responses-from-chat"

const chunk = (
  overrides: Partial<ChatCompletionChunk>,
): ChatCompletionChunk => ({
  id: "chatcmpl_stream_123",
  object: "chat.completion.chunk",
  created: 1_714_000_000,
  model: "gpt-4.1",
  choices: [],
  ...overrides,
})

describe("translateChatCompletionChunkToResponsesStreamEvents", () => {
  it("maps initial, text delta, and finish chunks into ordered Responses stream events", () => {
    const state = createChatCompletionToResponsesStreamState()
    const events = [
      translateChatCompletionChunkToResponsesStreamEvents(
        chunk({
          choices: [
            {
              index: 0,
              delta: { role: "assistant" },
              finish_reason: null,
              logprobs: null,
            },
          ],
        }),
        state,
      ),
      translateChatCompletionChunkToResponsesStreamEvents(
        chunk({
          choices: [
            {
              index: 0,
              delta: { content: "hello" },
              finish_reason: null,
              logprobs: null,
            },
          ],
        }),
        state,
      ),
      translateChatCompletionChunkToResponsesStreamEvents(
        chunk({
          choices: [
            {
              index: 0,
              delta: {},
              finish_reason: "stop",
              logprobs: null,
            },
          ],
          usage: {
            prompt_tokens: 3,
            completion_tokens: 1,
            total_tokens: 4,
          },
        }),
        state,
      ),
    ].flat()

    expect(events.map((event) => event.type)).toEqual([
      "response.created",
      "response.output_text.delta",
      "response.output_text.done",
      "response.completed",
    ])
    expect(events[1]).toMatchObject({
      type: "response.output_text.delta",
      delta: "hello",
      output_index: 0,
      content_index: 0,
    })
    expect(events[3]).toMatchObject({
      type: "response.completed",
      response: {
        id: "resp_chatcmpl_stream_123",
        output_text: "hello",
        status: "completed",
        usage: {
          input_tokens: 3,
          output_tokens: 1,
          total_tokens: 4,
        },
      },
    })
  })

  it("maps tool call argument deltas into function_call argument events and done", () => {
    const state = createChatCompletionToResponsesStreamState()
    const events = [
      translateChatCompletionChunkToResponsesStreamEvents(
        chunk({
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: "call_weather",
                    type: "function",
                    function: { name: "lookup_weather", arguments: '{"city":' },
                  },
                ],
              },
              finish_reason: null,
              logprobs: null,
            },
          ],
        }),
        state,
      ),
      translateChatCompletionChunkToResponsesStreamEvents(
        chunk({
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    function: { arguments: '"Hangzhou"}' },
                  },
                ],
              },
              finish_reason: null,
              logprobs: null,
            },
          ],
        }),
        state,
      ),
      translateChatCompletionChunkToResponsesStreamEvents(
        chunk({
          choices: [
            {
              index: 0,
              delta: {},
              finish_reason: "tool_calls",
              logprobs: null,
            },
          ],
        }),
        state,
      ),
    ].flat()

    expect(events.map((event) => event.type)).toEqual([
      "response.created",
      "response.function_call_arguments.delta",
      "response.function_call_arguments.delta",
      "response.function_call_arguments.done",
      "response.completed",
    ])
    expect(events[1]).toMatchObject({
      item_id: "fc_call_weather",
      output_index: 0,
      delta: '{"city":',
    })
    expect(events[3]).toMatchObject({
      type: "response.function_call_arguments.done",
      item_id: "fc_call_weather",
      output_index: 0,
      name: "lookup_weather",
      arguments: '{"city":"Hangzhou"}',
    })
    expect(events[4]).toMatchObject({
      type: "response.completed",
      response: {
        output: [
          {
            type: "function_call",
            call_id: "call_weather",
            name: "lookup_weather",
            arguments: '{"city":"Hangzhou"}',
            status: "completed",
          },
        ],
      },
    })
  })

  it("maps stream failures into response.failed", () => {
    const state = createChatCompletionToResponsesStreamState()
    translateChatCompletionChunkToResponsesStreamEvents(
      chunk({ choices: [] }),
      state,
    )

    const event = translateChatCompletionStreamErrorToResponsesEvent(
      new Error("upstream aborted"),
      state,
    )

    expect(event.type).toBe("response.failed")
    expect(event).toMatchObject({
      response: {
        id: "resp_chatcmpl_stream_123",
        status: "failed",
        error: { message: "upstream aborted" },
      },
    })
  })
})
