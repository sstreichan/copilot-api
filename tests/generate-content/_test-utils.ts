import { mock } from "bun:test"

import type { ChatCompletionsPayload } from "~/services/copilot/create-chat-completions"

import type {
  TestServer,
  MockChatCompletionsModule,
  MockRateLimitModule,
} from "./test-types"

export function asyncIterableFrom(
  events: Array<{ data?: string }>,
): AsyncIterable<{ data: string }> {
  return {
    [Symbol.asyncIterator]() {
      let i = 0
      return {
        next(): Promise<IteratorResult<{ data: string }>> {
          if (i < events.length) {
            const event = events[i++]
            return Promise.resolve({
              value: { data: event.data ?? "" },
              done: false,
            })
          }
          return Promise.resolve({
            value: undefined as unknown as { data: string },
            done: true,
          })
        },
      }
    },
  }
}

export function createMockChatCompletions(events: Array<{ data?: string }>) {
  return mock.module(
    "~/services/copilot/create-chat-completions",
    (): MockChatCompletionsModule => ({
      createChatCompletions: () => asyncIterableFrom(events),
    }),
  )
}

export function createMockRateLimit() {
  return mock.module(
    "~/lib/rate-limit",
    (): MockRateLimitModule => ({
      checkRateLimit: (_: unknown) => {},
    }),
  )
}

export async function makeRequest(
  path: string,
  body: Record<string, unknown>,
  queryString?: string,
): Promise<Response> {
  const serverModule = (await import(`~/server?${queryString}`)) as {
    server: TestServer
  }
  return serverModule.server.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
}

export const commonResponseData = {
  usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
}

export const sampleGeminiRequest = {
  contents: [{ role: "user", parts: [{ text: "Hello" }] }],
}

export const sampleToolCall = {
  index: 0,
  type: "function",
  function: {
    name: "ReadFile",
    arguments: '{"absolute_path": "/path/to/file.txt"}',
  },
}

// Additional helper types
export interface UsageTokens {
  prompt_tokens: number
  completion_tokens: number
  total_tokens: number
}

export interface NonStreamingChoice {
  index: number
  message: {
    role: "assistant"
    content: string | null
    tool_calls?: Array<{
      id: string
      type: "function"
      function: { name: string; arguments: string }
    }>
  }
  finish_reason: "stop" | "length" | "content_filter" | "tool_calls"
  logprobs: object | null
}

export interface NonStreamingResponse {
  id: string
  object: "chat.completion"
  created: number
  model: string
  choices: Array<NonStreamingChoice>
  usage: UsageTokens
}

/**
 * Build a non-streaming completion response with defaults
 */
export function buildNonStreamingResponse(
  options: {
    content?: string | null
    finishReason?: "stop" | "length" | "content_filter" | "tool_calls"
    usage?: Partial<UsageTokens>
    id?: string
    toolCalls?: Array<{
      id?: string
      name: string
      arguments: string
    }>
  } = {},
): NonStreamingResponse {
  const {
    content = "ok",
    finishReason = "stop",
    usage = {},
    id = "test-id",
    toolCalls,
  } = options

  const message: NonStreamingChoice["message"] = {
    role: "assistant",
    content,
  }

  if (toolCalls) {
    message.tool_calls = toolCalls.map((tc, idx) => ({
      id: tc.id ?? `call_${idx}`,
      type: "function",
      function: { name: tc.name, arguments: tc.arguments },
    }))
  }

  return {
    id,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: "gpt-4",
    choices: [
      {
        index: 0,
        message,
        finish_reason: finishReason,
        logprobs: null,
      },
    ],
    usage: {
      prompt_tokens: usage.prompt_tokens ?? 1,
      completion_tokens: usage.completion_tokens ?? 1,
      total_tokens: usage.total_tokens ?? 2,
    },
  }
}

/**
 * Create a mock for non-streaming chat completions with payload capture
 */
/* eslint-disable @typescript-eslint/no-unnecessary-type-parameters */
export async function createMockNonStreamingWithCapture<
  T = ChatCompletionsPayload,
>(
  response?: Partial<NonStreamingResponse>,
): Promise<{
  capturedPayload: { current: T | null }
}> {
  const capturedPayload: { current: T | null } = { current: null }

  await mock.module(
    "~/services/copilot/create-chat-completions",
    (): MockChatCompletionsModule => ({
      createChatCompletions: (payload: ChatCompletionsPayload) => {
        capturedPayload.current = payload as T
        return buildNonStreamingResponse(response)
      },
    }),
  )

  return { capturedPayload }
}

/**
 * Build streaming events with common patterns
 */
export interface StreamEventOptions {
  content?: string
  toolCalls?: Array<{
    name: string
    arguments: string
    index?: number
  }>
  finishReason?: "stop" | "length" | "content_filter" | null
  usage?: Partial<UsageTokens>
}

export function buildStreamEvents(
  options: StreamEventOptions,
): Array<{ data: string }> {
  const events: Array<{ data: string }> = []
  const { content, toolCalls, finishReason = "stop", usage } = options

  // Content chunk
  if (content) {
    events.push({
      data: JSON.stringify({
        id: "c1",
        choices: [{ index: 0, delta: { content }, finish_reason: null }],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      }),
    })
  }

  // Tool calls chunk
  if (toolCalls) {
    events.push({
      data: JSON.stringify({
        id: "c1",
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: toolCalls.map((tc, idx) => ({
                index: tc.index ?? idx,
                type: "function",
                function: { name: tc.name, arguments: tc.arguments },
              })),
            },
            finish_reason: null,
          },
        ],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      }),
    })
  }

  // Finish chunk
  events.push(
    {
      data: JSON.stringify({
        id: "c1",
        choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
        usage: {
          prompt_tokens: usage?.prompt_tokens ?? 1,
          completion_tokens: usage?.completion_tokens ?? 1,
          total_tokens: usage?.total_tokens ?? 2,
        },
      }),
    },
    { data: "[DONE]" },
  )

  return events
}

/**
 * Build tool call fragments for testing streaming accumulation
 */
export function buildToolCallFragments(
  toolName: string,
  args: Record<string, unknown>,
  fragmentCount = 2,
): Array<{ data: string }> {
  const argsStr = JSON.stringify(args)
  const fragmentSize = Math.ceil(argsStr.length / fragmentCount)
  const events: Array<{ data: string }> = []

  for (let i = 0; i < fragmentCount; i++) {
    const start = i * fragmentSize
    const end = Math.min((i + 1) * fragmentSize, argsStr.length)
    const fragment = argsStr.slice(start, end)

    const functionData: { name?: string; arguments: string } = {
      arguments: fragment,
    }
    if (i === 0) {
      functionData.name = toolName
    }

    events.push({
      data: JSON.stringify({
        id: "c1",
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  type: "function",
                  function: functionData,
                },
              ],
            },
            finish_reason: null,
          },
        ],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      }),
    })
  }

  // Add finish chunk
  events.push(
    {
      data: JSON.stringify({
        id: "c1",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
    },
    { data: "[DONE]" },
  )

  return events
}
