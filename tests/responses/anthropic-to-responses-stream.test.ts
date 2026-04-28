import { describe, expect, it } from "bun:test"

import {
  createAnthropicToResponsesStreamState,
  translateAnthropicStreamEventToResponsesStreamEvents,
} from "~/routes/responses/responses-from-messages"

// eslint-disable-next-line max-lines-per-function -- single describe colocates Anthropic stream → Responses event-mapping cases for atomic review
describe("translateAnthropicStreamEventToResponsesStreamEvents", () => {
  it("maps text stream into ordered Responses events", () => {
    const state = createAnthropicToResponsesStreamState()

    const events = [
      translateAnthropicStreamEventToResponsesStreamEvents(
        {
          type: "message_start",
          message: {
            id: "msg_123",
            type: "message",
            role: "assistant",
            content: [],
            model: "claude-sonnet-4.6",
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 10, output_tokens: 0 },
          },
        },
        state,
      ),
      translateAnthropicStreamEventToResponsesStreamEvents(
        {
          type: "content_block_start",
          index: 0,
          content_block: { type: "text", text: "" },
        },
        state,
      ),
      translateAnthropicStreamEventToResponsesStreamEvents(
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "Hello" },
        },
        state,
      ),
      translateAnthropicStreamEventToResponsesStreamEvents(
        {
          type: "content_block_stop",
          index: 0,
        },
        state,
      ),
      translateAnthropicStreamEventToResponsesStreamEvents(
        {
          type: "message_delta",
          delta: { stop_reason: "end_turn", stop_sequence: null },
          usage: { output_tokens: 1 },
        },
        state,
      ),
      translateAnthropicStreamEventToResponsesStreamEvents(
        { type: "message_stop" },
        state,
      ),
    ].flat()

    expect(events.map((event) => event.type)).toEqual([
      "response.created",
      "response.output_item.added",
      "response.output_text.delta",
      "response.output_text.done",
      "response.output_item.done",
      "response.completed",
    ])
    expect(events.map((event) => event.sequence_number)).toEqual([
      0, 1, 2, 3, 4, 5,
    ])
    expect(events[0]).toMatchObject({
      type: "response.created",
      response: {
        id: "msg_123",
        model: "claude-sonnet-4.6",
        status: "completed",
      },
    })
    expect(events[1]).toMatchObject({
      type: "response.output_item.added",
      output_index: 0,
      item: {
        id: "msg_123_message_0",
        type: "message",
        status: "in_progress",
      },
    })
    expect(events[2]).toMatchObject({
      type: "response.output_text.delta",
      item_id: "msg_123_message_0",
      output_index: 0,
      content_index: 0,
      delta: "Hello",
    })
    expect(events[3]).toMatchObject({
      type: "response.output_text.done",
      text: "Hello",
    })
    expect(events[4]).toMatchObject({
      type: "response.output_item.done",
      output_index: 0,
      item: {
        id: "msg_123_message_0",
        type: "message",
        status: "completed",
      },
    })
    expect(events[5]).toMatchObject({
      type: "response.completed",
      response: {
        output_text: "Hello",
        status: "completed",
        output: [
          {
            type: "message",
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text: "Hello", annotations: [] }],
          },
        ],
      },
    })
  })

  it("maps tool_use and input_json_delta into function call argument events in order", () => {
    const state = createAnthropicToResponsesStreamState()

    const events = [
      translateAnthropicStreamEventToResponsesStreamEvents(
        {
          type: "message_start",
          message: {
            id: "msg_tool",
            type: "message",
            role: "assistant",
            content: [],
            model: "claude-sonnet-4.6",
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 7, output_tokens: 0 },
          },
        },
        state,
      ),
      translateAnthropicStreamEventToResponsesStreamEvents(
        {
          type: "content_block_start",
          index: 1,
          content_block: {
            type: "tool_use",
            id: "tool_1",
            name: "lookup_weather",
            input: {},
          },
        },
        state,
      ),
      translateAnthropicStreamEventToResponsesStreamEvents(
        {
          type: "content_block_delta",
          index: 1,
          delta: { type: "input_json_delta", partial_json: '{"city":' },
        },
        state,
      ),
      translateAnthropicStreamEventToResponsesStreamEvents(
        {
          type: "content_block_delta",
          index: 1,
          delta: { type: "input_json_delta", partial_json: '"Hangzhou"}' },
        },
        state,
      ),
      translateAnthropicStreamEventToResponsesStreamEvents(
        {
          type: "content_block_stop",
          index: 1,
        },
        state,
      ),
      translateAnthropicStreamEventToResponsesStreamEvents(
        {
          type: "message_delta",
          delta: { stop_reason: "tool_use", stop_sequence: null },
          usage: { output_tokens: 2 },
        },
        state,
      ),
      translateAnthropicStreamEventToResponsesStreamEvents(
        { type: "message_stop" },
        state,
      ),
    ].flat()

    expect(events.map((event) => event.type)).toEqual([
      "response.created",
      "response.output_item.added",
      "response.function_call_arguments.delta",
      "response.function_call_arguments.delta",
      "response.function_call_arguments.done",
      "response.output_item.done",
      "response.completed",
    ])
    expect(events.map((event) => event.sequence_number)).toEqual([
      0, 1, 2, 3, 4, 5, 6,
    ])
    expect(events[1]).toMatchObject({
      type: "response.output_item.added",
      output_index: 0,
      item: {
        id: "fc_tool_1",
        type: "function_call",
        status: "in_progress",
      },
    })
    expect(events[2]).toMatchObject({
      type: "response.function_call_arguments.delta",
      item_id: "fc_tool_1",
      output_index: 0,
      delta: '{"city":',
    })
    expect(events[3]).toMatchObject({
      type: "response.function_call_arguments.delta",
      item_id: "fc_tool_1",
      output_index: 0,
      delta: '"Hangzhou"}',
    })
    expect(events[4]).toMatchObject({
      type: "response.function_call_arguments.done",
      item_id: "fc_tool_1",
      output_index: 0,
      name: "lookup_weather",
      arguments: '{"city":"Hangzhou"}',
    })
    expect(events[5]).toMatchObject({
      type: "response.output_item.done",
      output_index: 0,
      item: {
        id: "fc_tool_1",
        type: "function_call",
        status: "completed",
      },
    })
    expect(events[6]).toMatchObject({
      type: "response.completed",
      response: {
        status: "completed",
        output: [
          {
            id: "fc_tool_1",
            type: "function_call",
            call_id: "tool_1",
            name: "lookup_weather",
            arguments: '{"city":"Hangzhou"}',
            status: "completed",
          },
        ],
      },
    })
  })

  it("drops ping events", () => {
    const state = createAnthropicToResponsesStreamState()
    const events = translateAnthropicStreamEventToResponsesStreamEvents(
      { type: "ping" },
      state,
    )

    expect(events).toEqual([])
  })

  it("maps error events into response.failed", () => {
    const state = createAnthropicToResponsesStreamState()
    translateAnthropicStreamEventToResponsesStreamEvents(
      {
        type: "message_start",
        message: {
          id: "msg_error",
          type: "message",
          role: "assistant",
          content: [],
          model: "claude-sonnet-4.6",
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 0 },
        },
      },
      state,
    )

    const [event] = translateAnthropicStreamEventToResponsesStreamEvents(
      {
        type: "error",
        error: { type: "api_error", message: "upstream aborted" },
      },
      state,
    )

    expect(event).toMatchObject({
      type: "response.failed",
      response: {
        id: "msg_error",
        status: "failed",
        error: { message: "upstream aborted" },
      },
    })
  })

  it("maps max_tokens stop into response.incomplete", () => {
    const state = createAnthropicToResponsesStreamState()

    const events = [
      translateAnthropicStreamEventToResponsesStreamEvents(
        {
          type: "message_start",
          message: {
            id: "msg_incomplete",
            type: "message",
            role: "assistant",
            content: [],
            model: "claude-sonnet-4.6",
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 4, output_tokens: 0 },
          },
        },
        state,
      ),
      translateAnthropicStreamEventToResponsesStreamEvents(
        {
          type: "message_delta",
          delta: { stop_reason: "max_tokens", stop_sequence: null },
          usage: { output_tokens: 3 },
        },
        state,
      ),
      translateAnthropicStreamEventToResponsesStreamEvents(
        { type: "message_stop" },
        state,
      ),
    ].flat()

    const lastEvent = events.at(-1)
    expect(lastEvent).toMatchObject({
      type: "response.incomplete",
      response: {
        id: "msg_incomplete",
        status: "incomplete",
        incomplete_details: { reason: "max_output_tokens" },
      },
    })
  })
})
