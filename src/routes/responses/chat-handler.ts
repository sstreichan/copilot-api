import type { Context } from "hono"
import { streamSSE } from "hono/streaming"

import {
  applyForwardableResponseHeaders,
  getAttachedResponseHeaders,
} from "~/lib/response-headers"
import type { SubagentMarker } from "~/lib/subagent"
import {
  copilotUsageToTokens,
  createCopilotTokenUsageRecorder,
  mergeCopilotUsage,
  normalizeOpenAIUsage,
  type CopilotUsageTokens,
  type UsageTokens,
} from "~/lib/token-usage"
import type {
  ChatCompletionChunk,
  ChatCompletionResponse,
} from "~/lib/types/chat-completions"
import type { ResponsesPayload } from "~/lib/types/responses"
import { isAsyncIterable } from "~/lib/utils"
import { createChatCompletions } from "~/services/copilot/create-chat-completions"

import {
  createChatCompletionToResponsesStreamState,
  flushChatCompletionToResponsesStreamEvents,
  translateChatCompletionChunkToResponsesStreamEvents,
  translateChatCompletionStreamErrorToResponsesEvent,
  translateChatCompletionToResponsesResult,
  translateResponsesToChatCompletions,
} from "./responses-from-chat"
import { compactInputByLatestCompaction } from "./utils"

export const responsesChatDependencies = {
  createChatCompletions,
}

const isChatCompletionResponse = (
  value: unknown,
): value is ChatCompletionResponse => {
  return (
    typeof value === "object"
    && value !== null
    && "object" in value
    && value.object === "chat.completion"
  )
}

export async function handleResponsesViaChatCompletions(
  c: Context,
  options: {
    payload: ResponsesPayload
    subagentMarker?: SubagentMarker | null
    requestId?: string
    sessionId?: string
  },
): Promise<Response> {
  compactInputByLatestCompaction(options.payload)
  const recordUsage = createCopilotTokenUsageRecorder({
    endpoint: "responses",
    fallbackSessionId: options.sessionId,
    model: options.payload.model,
  })
  const chatPayload = translateResponsesToChatCompletions(options.payload)
  const chatResponse = await responsesChatDependencies.createChatCompletions(
    chatPayload,
    {
      requestId: options.requestId,
      sessionId: options.sessionId,
      subagentMarker: options.subagentMarker,
    },
  )
  applyForwardableResponseHeaders(c, getAttachedResponseHeaders(chatResponse))

  if (!options.payload.stream) {
    if (!isChatCompletionResponse(chatResponse)) {
      return c.json(
        {
          error: {
            message: "Chat Completions fallback returned a stream",
            type: "invalid_request_error",
          },
        },
        502,
      )
    }
    recordUsage(
      normalizeOpenAIUsage(chatResponse.usage),
      copilotUsageToTokens(chatResponse.copilot_usage),
    )
    return c.json(translateChatCompletionToResponsesResult(chatResponse))
  }

  if (!isAsyncIterable<ChatCompletionChunk>(chatResponse)) {
    return c.json(
      {
        error: {
          message: "Chat Completions fallback did not return a stream",
          type: "invalid_request_error",
        },
      },
      502,
    )
  }

  return streamSSE(c, async (stream) => {
    const state = createChatCompletionToResponsesStreamState()
    let usage: UsageTokens = {}
    let copilotUsage: CopilotUsageTokens = {}

    try {
      for await (const chunk of chatResponse) {
        if (chunk.usage) {
          usage = normalizeOpenAIUsage(chunk.usage)
        }
        if (chunk.copilot_usage) {
          copilotUsage = mergeCopilotUsage(
            copilotUsage,
            copilotUsageToTokens(chunk.copilot_usage),
          )
        }
        for (const event of translateChatCompletionChunkToResponsesStreamEvents(
          chunk,
          state,
        )) {
          await stream.writeSSE({
            event: event.type,
            data: JSON.stringify(event),
          })
        }
      }

      for (const event of flushChatCompletionToResponsesStreamEvents(state)) {
        await stream.writeSSE({
          event: event.type,
          data: JSON.stringify(event),
        })
      }
    } catch (error) {
      if (!state.terminalEmitted) {
        const event = translateChatCompletionStreamErrorToResponsesEvent(
          error,
          state,
        )
        await stream.writeSSE({
          event: event.type,
          data: JSON.stringify(event),
        })
      }
    } finally {
      recordUsage(usage, copilotUsage)
      if (!stream.closed) {
        await stream.close()
      }
    }
  })
}
