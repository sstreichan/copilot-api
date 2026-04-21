import type { ConsolaInstance } from "consola"
import type { Context } from "hono"
import type { ContentfulStatusCode } from "hono/utils/http-status"

import { streamSSE } from "hono/streaming"

import type { CompactType } from "~/lib/compact"
import type { SubagentMarker } from "~/lib/subagent"
import type { Model } from "~/services/copilot/get-models"

import {
  debugJson,
  debugJsonTail,
  debugLazy,
  resolvePremiumInfo,
  writeStreamLog,
} from "~/lib/logger"
import {
  cloneForwardableResponseHeaders,
  applyForwardableResponseHeaders,
  getAttachedResponseHeaders,
  jsonWithForwardedHeaders,
} from "~/lib/response-headers"
import { setupPingInterval } from "~/lib/utils"
import {
  buildErrorEvent,
  createResponsesStreamState,
  translateResponsesStreamEvent,
} from "~/routes/messages/responses-stream-translation"
import {
  translateAnthropicMessagesToResponsesPayload,
  translateResponsesResultToAnthropic,
} from "~/routes/messages/responses-translation"
import {
  applyResponsesApiContextManagement,
  compactInputByLatestCompaction,
  getResponsesRequestOptions,
} from "~/routes/responses/utils"
import {
  createChatCompletions,
  type ChatCompletionChunk,
  type ChatCompletionResponse,
} from "~/services/copilot/create-chat-completions"
import { createMessages } from "~/services/copilot/create-messages"
import {
  createResponses,
  type ResponsesResult,
  type ResponseStreamEvent,
} from "~/services/copilot/create-responses"

import {
  type AnthropicMessagesPayload,
  type AnthropicStreamState,
} from "./anthropic-types"
import {
  translateToAnthropic,
  translateToOpenAI,
} from "./non-stream-translation"
import { prepareMessagesApiPayload } from "./preprocess"
import { translateChunkToAnthropicEvents } from "./stream-translation"

export interface FlowBaseOptions {
  logger: ConsolaInstance
  subagentMarker?: SubagentMarker | null
  requestId: string
  sessionId?: string
  compactType?: CompactType
}

interface ResponsesFlowOptions extends FlowBaseOptions {
  selectedModel?: Model
}

interface MessagesFlowOptions extends FlowBaseOptions {
  anthropicBetaHeader?: string
  selectedModel?: Model
}

export const handleWithChatCompletions = async (
  c: Context,
  anthropicPayload: AnthropicMessagesPayload,
  options: FlowBaseOptions,
) => {
  const { logger, subagentMarker, requestId, sessionId, compactType } = options
  const openAIPayload = translateToOpenAI(anthropicPayload)
  debugJson(logger, "Translated OpenAI request payload:", openAIPayload)

  const response = await createChatCompletions(openAIPayload, {
    subagentMarker,
    requestId,
    sessionId,
    compactType,
  })

  if (isNonStreaming(response)) {
    debugJson(logger, "Non-streaming response from Copilot:", response)
    const anthropicResponse = translateToAnthropic(response)
    debugJson(logger, "Translated Anthropic response:", anthropicResponse)
    const premium = await resolvePremiumInfo(
      response,
      "messages/chat-non-stream",
    )
    writeStreamLog(
      { model: openAIPayload.model, chunks: 0, done: true, premium },
      true,
    )
    return jsonWithForwardedHeaders(
      anthropicResponse,
      getAttachedResponseHeaders(response),
    )
  }

  logger.debug("Streaming response from Copilot")
  applyForwardableResponseHeaders(c, getAttachedResponseHeaders(response), {
    "content-type": null,
    "cache-control": null,
    connection: null,
  })
  return streamSSE(c, async (stream) => {
    const pingInterval = setupPingInterval(stream)

    const streamState: AnthropicStreamState = {
      messageStartSent: false,
      contentBlockIndex: 0,
      contentBlockOpen: false,
      toolCalls: {},
      thinkingBlockOpen: false,
    }

    let chunkCount = 0
    try {
      for await (const rawEvent of response) {
        debugJson(logger, "Copilot raw stream event:", rawEvent)
        if (rawEvent.data === "[DONE]") {
          break
        }

        if (!rawEvent.data) {
          continue
        }

        chunkCount++

        const chunk = JSON.parse(rawEvent.data) as ChatCompletionChunk
        const events = translateChunkToAnthropicEvents(chunk, streamState)

        for (const event of events) {
          const eventData = JSON.stringify(event)
          debugLazy(logger, () => ["Translated Anthropic event:", eventData])
          await stream.writeSSE({
            event: event.type,
            data: eventData,
          })
        }
      }
    } finally {
      clearInterval(pingInterval)
      const premium = await resolvePremiumInfo(response, "messages/chat-stream")
      writeStreamLog(
        {
          model: openAIPayload.model,
          chunks: chunkCount,
          done: true,
          premium,
        },
        true,
      )
    }
  })
}

export const handleWithResponsesApi = async (
  c: Context,
  anthropicPayload: AnthropicMessagesPayload,
  options: ResponsesFlowOptions,
) => {
  const {
    logger,
    subagentMarker,
    selectedModel,
    requestId,
    sessionId,
    compactType,
  } = options

  const responsesPayload =
    translateAnthropicMessagesToResponsesPayload(anthropicPayload)

  applyResponsesApiContextManagement(
    responsesPayload,
    selectedModel?.capabilities.limits.max_prompt_tokens,
  )

  if (compactType === 0) {
    compactInputByLatestCompaction(responsesPayload)
  }

  debugJson(logger, "Translated Responses payload:", responsesPayload)

  const { vision, initiator } = getResponsesRequestOptions(responsesPayload)
  const response = await createResponses(responsesPayload, {
    vision,
    initiator,
    subagentMarker,
    requestId,
    sessionId,
    compactType,
  })

  if (responsesPayload.stream && isAsyncIterable(response)) {
    logger.debug("Streaming response from Copilot (Responses API)")
    applyForwardableResponseHeaders(c, getAttachedResponseHeaders(response), {
      "content-type": null,
      "cache-control": null,
      connection: null,
    })
    return streamSSE(c, (stream) =>
      handleResponsesStream({
        stream,
        response,
        model: responsesPayload.model,
        logger,
      }),
    )
  }

  debugJsonTail(logger, "Non-streaming Responses result:", {
    value: response,
    tailLength: 400,
  })
  const anthropicResponse = translateResponsesResultToAnthropic(
    response as ResponsesResult,
  )
  debugJson(logger, "Translated Anthropic response:", anthropicResponse)
  const premium = await resolvePremiumInfo(
    response,
    "messages/responses-non-stream",
  )
  writeStreamLog(
    { model: responsesPayload.model, chunks: 0, done: true, premium },
    true,
  )
  return jsonWithForwardedHeaders(
    anthropicResponse,
    getAttachedResponseHeaders(response),
  )
}

export const handleWithMessagesApi = async (
  c: Context,
  anthropicPayload: AnthropicMessagesPayload,
  options: MessagesFlowOptions,
) => {
  const {
    logger,
    anthropicBetaHeader,
    subagentMarker,
    selectedModel,
    requestId,
    sessionId,
    compactType,
  } = options

  prepareMessagesApiPayload(anthropicPayload, selectedModel)

  debugJson(logger, "Translated Messages payload:", anthropicPayload)

  const response = await createMessages(anthropicPayload, {
    initiator: getInitiatorFromPayload(anthropicPayload),
    anthropicBeta: anthropicBetaHeader,
    subagentMarker,
    requestId,
    sessionId,
    compactType,
  })

  if (anthropicPayload.stream && response.body) {
    logger.debug("Streaming response from Copilot (Messages API)")
    const responseHeaders =
      getAttachedResponseHeaders(response) ?? response.headers

    const premium = await resolvePremiumInfo(response, "messages/native-stream")
    const countedBody = createNativeStreamBody({
      body: response.body,
      model: anthropicPayload.model,
      premium,
      logger,
    })

    const headers = Object.fromEntries(
      applyNativeStreamResponseHeaders(responseHeaders).entries(),
    )

    return c.body(countedBody, response.status as ContentfulStatusCode, headers)
  }

  const jsonResponse = await response.json()
  debugJsonTail(logger, "Non-streaming Messages result:", {
    value: jsonResponse,
    tailLength: 400,
  })
  const premium = await resolvePremiumInfo(
    response,
    "messages/native-non-stream",
  )
  writeStreamLog(
    { model: anthropicPayload.model, chunks: 0, done: true, premium },
    true,
  )
  return jsonWithForwardedHeaders(
    jsonResponse,
    getAttachedResponseHeaders(response) ?? response.headers,
  )
}

const handleResponsesStream = async (options: {
  stream: Parameters<Parameters<typeof streamSSE>[1]>[0] extends infer S ? S
  : never
  response: AsyncIterable<{ event?: string; data?: string }>
  model: string
  logger: ConsolaInstance
}) => {
  const { stream, response, model, logger } = options
  const pingInterval = setupPingInterval(stream)
  const streamState = createResponsesStreamState()

  let chunkCount = 0
  try {
    for await (const chunk of response) {
      const eventName = chunk.event
      if (eventName === "ping") {
        await stream.writeSSE({ event: "ping", data: '{"type":"ping"}' })
        continue
      }

      const data = chunk.data
      if (!data) {
        continue
      }

      chunkCount++
      debugLazy(logger, () => ["Responses raw stream event:", data])

      const events = translateResponsesStreamEvent(
        JSON.parse(data) as ResponseStreamEvent,
        streamState,
      )
      for (const event of events) {
        const eventData = JSON.stringify(event)
        debugLazy(logger, () => ["Translated Anthropic event:", eventData])
        await stream.writeSSE({
          event: event.type,
          data: eventData,
        })
      }

      if (streamState.messageCompleted) {
        logger.debug("Message completed, ending stream")
        break
      }
    }

    if (!streamState.messageCompleted) {
      logger.warn(
        "Responses stream ended without completion; sending error event",
      )
      const errorEvent = buildErrorEvent(
        "Responses stream ended without completion",
      )
      await stream.writeSSE({
        event: errorEvent.type,
        data: JSON.stringify(errorEvent),
      })
    }
  } finally {
    clearInterval(pingInterval)
    const premium = await resolvePremiumInfo(
      response,
      "messages/responses-stream",
    )
    writeStreamLog({ model, chunks: chunkCount, done: true, premium }, true)
  }
}

const applyNativeStreamResponseHeaders = (headers: Headers): Headers => {
  return cloneForwardableResponseHeaders(headers, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  })
}

const createNativeStreamBody = (options: {
  body: ReadableStream
  model: string
  premium: { remaining: number; total: number } | null
  logger: ConsolaInstance
}): ReadableStream<Uint8Array> => {
  const { body, model, premium, logger } = options
  let chunkCount = 0
  let buffer = ""
  const decoder = new TextDecoder()
  const reader = body.getReader()

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const result = await reader.read()

      if (result.done) {
        buffer += decoder.decode()
        buffer = buffer.replaceAll("\r\n", "\n")
        if (buffer.trim().length > 0) {
          chunkCount++
        }

        writeStreamLog({ model, chunks: chunkCount, done: true, premium }, true)

        controller.close()
        return
      }

      const chunk = result.value as Uint8Array
      controller.enqueue(chunk)

      const decodedChunk = decoder.decode(chunk, { stream: true })
      debugLazy(logger, () => ["Messages raw stream event:", decodedChunk])

      buffer += decodedChunk
      buffer = buffer.replaceAll("\r\n", "\n")
      const parts = buffer.split("\n\n")
      buffer = parts.pop() ?? ""

      const newEvents = parts.filter(
        (eventText) => eventText.trim().length > 0,
      ).length
      if (newEvents > 0) {
        chunkCount += newEvents
      }
    },
    cancel() {
      void reader.cancel()
    },
  })
}

export const getInitiatorFromPayload = (
  payload: AnthropicMessagesPayload,
): "user" | "agent" => {
  if (payload.messages.length === 0) {
    return "user"
  }

  const lastMessage = payload.messages.at(-1)
  if (
    lastMessage?.role === "user"
    && Array.isArray(lastMessage.content)
    && lastMessage.content.some((block) => block.type === "tool_result")
  ) {
    return "agent"
  }

  return lastMessage?.role === "assistant" ? "agent" : "user"
}

const isNonStreaming = (
  response: Awaited<ReturnType<typeof createChatCompletions>>,
): response is ChatCompletionResponse => Object.hasOwn(response, "choices")

const isAsyncIterable = <T>(value: unknown): value is AsyncIterable<T> =>
  Boolean(value)
  && typeof (value as AsyncIterable<T>)[Symbol.asyncIterator] === "function"

export const isClaudeModel = (model: string): boolean =>
  model.toLowerCase().startsWith("claude")
