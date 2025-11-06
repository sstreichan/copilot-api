import { expect, test, mock } from "bun:test"

import type {
  ResponsesPayload,
  ResponseStreamEvent,
} from "~/services/copilot/create-responses"

import { makeRequest, createMockRateLimit } from "./_test-utils"

// Phase 2 test: streaming codex model uses Responses API streaming path
test("codex streaming request uses Responses API streaming path", async () => {
  await createMockRateLimit()
  let capturedResponsesPayload: ResponsesPayload | undefined

  // Mock streaming events sequence
  const mockStreamEvents: Array<{ data: string }> = [
    {
      data: JSON.stringify({
        type: "response.created",
        response: {
          id: "resp-stream-1",
          model: "gpt-5-codex",
          output: [],
          status: "in_progress",
        },
        sequence_number: 0,
      } as unknown as ResponseStreamEvent),
    },
    {
      data: JSON.stringify({
        type: "response.output_item.added",
        item: {
          type: "message",
          role: "assistant",
          content: [],
        },
        output_index: 0,
        sequence_number: 1,
      } as unknown as ResponseStreamEvent),
    },
    {
      data: JSON.stringify({
        type: "response.output_text.delta",
        delta: "Hello",
        item_id: "msg-1",
        output_index: 0,
        content_index: 0,
        sequence_number: 2,
      } as unknown as ResponseStreamEvent),
    },
    {
      data: JSON.stringify({
        type: "response.output_text.delta",
        delta: " from codex",
        item_id: "msg-1",
        output_index: 0,
        content_index: 0,
        sequence_number: 3,
      } as unknown as ResponseStreamEvent),
    },
    {
      data: JSON.stringify({
        type: "response.completed",
        response: {
          id: "resp-stream-1",
          model: "gpt-5-codex",
          output: [
            {
              id: "msg-1",
              type: "message",
              role: "assistant",
              status: "completed",
              content: [
                {
                  type: "output_text",
                  text: "Hello from codex",
                  annotations: [],
                },
              ],
            },
          ],
          output_text: "Hello from codex",
          status: "completed",
          usage: {
            input_tokens: 30,
            output_tokens: 10,
            total_tokens: 40,
          },
        },
        sequence_number: 4,
      } as unknown as ResponseStreamEvent),
    },
  ]

  function* mockResponsesStream() {
    for (const event of mockStreamEvents) {
      yield event
    }
  }

  await mock.module("~/services/copilot/create-responses", () => ({
    createResponses: (payload: ResponsesPayload) => {
      capturedResponsesPayload = payload
      return mockResponsesStream()
    },
  }))

  const response = await makeRequest(
    "/v1beta/models/gemini-2.5-codex:streamGenerateContent",
    {
      contents: [{ role: "user", parts: [{ text: "Say hi" }] }],
    },
  )

  expect(response.status).toBe(200)
  expect(response.headers.get("content-type")).toContain("text/event-stream")

  // Verify Responses API was called with stream=true
  expect(capturedResponsesPayload).toBeDefined()
  if (!capturedResponsesPayload) throw new Error("responses payload missing")
  expect(capturedResponsesPayload.model).toBe("gpt-5-codex")
  expect(capturedResponsesPayload.stream).toBe(true)

  // Parse SSE stream
  const text = await response.text()
  const lines = text.split("\n").filter((line) => line.startsWith("data: "))
  expect(lines.length).toBeGreaterThan(0)

  // Verify Gemini stream format (candidates with parts)
  const firstDataLine = lines[0]
  const firstChunk = JSON.parse(firstDataLine.replace("data: ", "")) as {
    candidates?: Array<unknown>
  }
  expect(firstChunk).toHaveProperty("candidates")
  expect(Array.isArray(firstChunk.candidates)).toBe(true)
})

test("codex streaming with tool calls", async () => {
  await createMockRateLimit()

  const mockStreamEvents: Array<{ data: string }> = [
    {
      data: JSON.stringify({
        type: "response.created",
        response: {
          id: "resp-2",
          model: "gpt-5-codex",
          output: [],
          status: "in_progress",
        },
        sequence_number: 0,
      } as unknown as ResponseStreamEvent),
    },
    {
      data: JSON.stringify({
        type: "response.output_item.added",
        item: {
          type: "function_call",
          call_id: "call-1",
          name: "get_weather",
          arguments: "",
        },
        output_index: 0,
        sequence_number: 1,
      } as unknown as ResponseStreamEvent),
    },
    {
      data: JSON.stringify({
        type: "response.function_call_arguments.delta",
        delta: '{"location"',
        item_id: "call-1",
        output_index: 0,
        sequence_number: 2,
      } as unknown as ResponseStreamEvent),
    },
    {
      data: JSON.stringify({
        type: "response.function_call_arguments.delta",
        delta: ':"SF"}',
        item_id: "call-1",
        output_index: 0,
        sequence_number: 3,
      } as unknown as ResponseStreamEvent),
    },
    {
      data: JSON.stringify({
        type: "response.function_call_arguments.done",
        arguments: '{"location":"SF"}',
        name: "get_weather",
        item_id: "call-1",
        output_index: 0,
        sequence_number: 4,
      } as unknown as ResponseStreamEvent),
    },
    {
      data: JSON.stringify({
        type: "response.completed",
        response: {
          id: "resp-2",
          model: "gpt-5-codex",
          output: [
            {
              id: "call-1",
              type: "function_call",
              call_id: "call-1",
              name: "get_weather",
              arguments: '{"location":"SF"}',
              status: "completed",
            },
          ],
          output_text: "",
          status: "completed",
          usage: { input_tokens: 40, output_tokens: 15, total_tokens: 55 },
        },
        sequence_number: 5,
      } as unknown as ResponseStreamEvent),
    },
  ]

  function* mockResponsesStream() {
    for (const event of mockStreamEvents) {
      yield event
    }
  }

  await mock.module("~/services/copilot/create-responses", () => ({
    createResponses: () => mockResponsesStream(),
  }))

  const response = await makeRequest(
    "/v1beta/models/gemini-2.5-codex:streamGenerateContent",
    {
      contents: [{ role: "user", parts: [{ text: "Weather in SF?" }] }],
      tools: [
        {
          functionDeclarations: [
            {
              name: "get_weather",
              description: "Get weather",
              parameters: {
                type: "object",
                properties: { location: { type: "string" } },
              },
            },
          ],
        },
      ],
    },
  )

  expect(response.status).toBe(200)

  const text = await response.text()
  const dataLines = text.split("\n").filter((line) => line.startsWith("data: "))

  // Find the chunk with functionCall
  let foundToolCall = false
  for (const line of dataLines) {
    const chunk = JSON.parse(line.replace("data: ", "")) as {
      candidates?: Array<{
        content?: {
          parts?: Array<unknown>
        }
      }>
    }
    if (chunk.candidates?.[0]?.content?.parts) {
      const parts = chunk.candidates[0].content.parts
      const hasFunctionCall = parts.some(
        (p: unknown) =>
          Boolean(p)
          && typeof p === "object"
          && "functionCall" in (p as { functionCall?: unknown }),
      )
      if (hasFunctionCall) {
        foundToolCall = true
        break
      }
    }
  }

  expect(foundToolCall).toBe(true)
})
