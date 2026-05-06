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
import {
  createCopilotTokenUsageRecorder,
  mergeAnthropicUsage,
  normalizeAnthropicUsage,
  normalizeOpenAIUsage,
  normalizeResponsesUsage,
  type TokenUsageEndpoint,
  type UsageTokens,
} from "~/lib/token-usage"
import { setupPingInterval } from "~/lib/utils"
import { parseUserIdMetadata } from "~/lib/utils"
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
  type ChatCompletionsPayload,
  type Message,
} from "~/services/copilot/create-chat-completions"
import { createMessages } from "~/services/copilot/create-messages"
import {
  createResponses,
  type ResponsesResult,
  type ResponseStreamEvent,
} from "~/services/copilot/create-responses"

import {
  type AnthropicMessagesPayload,
  type AnthropicStreamEventData,
  type AnthropicStreamState,
} from "./anthropic-types"
import {
  translateToAnthropic,
  translateToOpenAI,
} from "./non-stream-translation"
import { prepareMessagesApiPayload } from "./preprocess"
import {
  flushPendingAnthropicStreamEvents,
  translateChunkToAnthropicEvents,
} from "./stream-translation"

const COPILOT_CONTEXT_CACHE_SYSTEM_MARKER_LIMIT = 2
const COPILOT_CONTEXT_CACHE_NON_SYSTEM_MARKER_LIMIT = 2
const COPILOT_CONTEXT_CACHE_CONTROL = {
  type: "ephemeral",
} as const

export interface FlowBaseOptions {
  logger: ConsolaInstance
  subagentMarker?: SubagentMarker | null
  requestId: string
  requestSessionAffinity?: string
  requestTraceId?: string
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
  const {
    logger,
    requestSessionAffinity,
    requestTraceId,
    subagentMarker,
    requestId,
    sessionId,
    compactType,
  } = options
  const openAIPayload = translateToOpenAI(anthropicPayload)
  prepareCopilotChatCompletionsPayload(openAIPayload)
  const recordUsage = createMessagesFlowUsageRecorder({
    anthropicPayload,
    endpoint: "chat_completions",
    fallbackSessionId: sessionId,
    model: openAIPayload.model,
    requestSessionAffinity,
    requestTraceId,
  })
  debugJson(logger, "Translated OpenAI request payload:", openAIPayload)

  const response = await createChatCompletions(openAIPayload, {
    subagentMarker,
    requestId,
    sessionId,
    compactType,
  })

  if (isNonStreaming(response)) {
    return handleChatCompletionsNonStream({
      logger,
      model: openAIPayload.model,
      recordUsage,
      response,
    })
  }

  return handleChatCompletionsStream({
    c,
    logger,
    model: openAIPayload.model,
    recordUsage,
    response,
  })
}

const handleChatCompletionsStream = (options: {
  c: Context
  logger: ConsolaInstance
  model: string
  recordUsage: (usage: UsageTokens) => void
  response: AsyncIterable<{ data?: string }>
}) => {
  const { c, logger, model, recordUsage, response } = options
  logger.debug("Streaming response from Copilot")
  applyForwardableResponseHeaders(c, getAttachedResponseHeaders(response), {
    "content-type": null,
    "cache-control": null,
    connection: null,
  })
  return streamSSE(c, async (stream) => {
    const pingInterval = setupPingInterval(stream)
    let usage: UsageTokens = {}
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

        const chunk = JSON.parse(rawEvent.data) as ChatCompletionChunk
        chunkCount++
        if (chunk.usage) {
          usage = normalizeOpenAIUsage(chunk.usage)
        }
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
          model,
          chunks: chunkCount,
          done: true,
          premium,
        },
        true,
      )
    }

    for (const event of flushPendingAnthropicStreamEvents(streamState)) {
      const eventData = JSON.stringify(event)
      debugLazy(logger, () => ["Translated Anthropic event:", eventData])
      await stream.writeSSE({
        event: event.type,
        data: eventData,
      })
    }

    recordUsage(usage)
  })
}

const handleChatCompletionsNonStream = async (options: {
  logger: ConsolaInstance
  model: string
  recordUsage: (usage: UsageTokens) => void
  response: ChatCompletionResponse
}) => {
  const { logger, model, recordUsage, response } = options
  debugJson(logger, "Non-streaming response from Copilot:", response)
  recordUsage(normalizeOpenAIUsage(response.usage))
  const anthropicResponse = translateToAnthropic(response)
  debugJson(logger, "Translated Anthropic response:", anthropicResponse)
  const premium = await resolvePremiumInfo(response, "messages/chat-non-stream")
  writeStreamLog({ model, chunks: 0, done: true, premium }, true)
  return jsonWithForwardedHeaders(
    anthropicResponse,
    getAttachedResponseHeaders(response),
  )
}

export const handleWithResponsesApi = async (
  c: Context,
  anthropicPayload: AnthropicMessagesPayload,
  options: ResponsesFlowOptions,
) => {
  const {
    logger,
    requestSessionAffinity,
    requestTraceId,
    selectedModel,
    compactType,
    ...requestOptions
  } = options

  const responsesPayload =
    translateAnthropicMessagesToResponsesPayload(anthropicPayload)
  const recordUsage = createCopilotUsageRecorder({
    endpoint: "responses",
    fallbackSessionId: requestOptions.sessionId,
    model: responsesPayload.model,
    payload: anthropicPayload,
    requestSessionAffinity,
    requestTraceId,
  })

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
    ...requestOptions,
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
        recordUsage,
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
  recordUsage(normalizeResponsesUsage((response as ResponsesResult).usage))
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
    requestSessionAffinity,
    requestTraceId,
    subagentMarker,
    selectedModel,
    requestId,
    sessionId,
    compactType,
  } = options

  prepareMessagesApiPayload(anthropicPayload, selectedModel)
  const recordUsage = createCopilotUsageRecorder({
    endpoint: "messages",
    fallbackSessionId: sessionId,
    model: anthropicPayload.model,
    payload: anthropicPayload,
    requestSessionAffinity,
    requestTraceId,
  })

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
      recordUsage,
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
  recordUsage(
    normalizeAnthropicUsage(
      (
        jsonResponse as {
          usage?: Parameters<typeof normalizeAnthropicUsage>[0]
        }
      ).usage,
    ),
  )
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
  recordUsage: (usage: UsageTokens) => void
}) => {
  const { stream, response, model, logger, recordUsage } = options
  const pingInterval = setupPingInterval(stream)
  const streamState = createResponsesStreamState()
  let usage: UsageTokens = {}

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

      const responseEvent = JSON.parse(data) as ResponseStreamEvent
      if (
        responseEvent.type === "response.completed"
        || responseEvent.type === "response.failed"
        || responseEvent.type === "response.incomplete"
      ) {
        usage = normalizeResponsesUsage(responseEvent.response.usage)
      }

      const events = translateResponsesStreamEvent(responseEvent, streamState)
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
    recordUsage(usage)
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
  recordUsage: (usage: UsageTokens) => void
}): ReadableStream<Uint8Array> => {
  const { body, model, premium, logger, recordUsage } = options
  let chunkCount = 0
  let usage: UsageTokens = {}
  let usageRecorded = false
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
        if (!usageRecorded) {
          recordUsage(usage)
        }

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

      const newEvents = parts.filter((eventText) => {
        if (eventText.trim().length === 0) return false
        const dataLine = eventText
          .split("\n")
          .find((l) => l.startsWith("data:"))
        const data = dataLine ? dataLine.slice(5).trim() : ""
        const parsedEvent = parseAnthropicStreamEvent(data)
        if (parsedEvent?.type === "message_start") {
          usage = mergeAnthropicUsage(
            usage,
            normalizeAnthropicUsage(getAnthropicMessageStartUsage(parsedEvent)),
          )
        } else if (parsedEvent?.type === "message_delta") {
          usage = mergeAnthropicUsage(
            usage,
            normalizeAnthropicUsage(parsedEvent.usage),
          )
        }
        if (!usageRecorded && parsedEvent?.type === "message_delta") {
          recordUsage(usage)
          usageRecorded = true
        }
        return data !== "" && data !== "[DONE]"
      }).length
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

export const prepareCopilotChatCompletionsPayload = (
  payload: ChatCompletionsPayload,
): void => {
  applyCopilotContextCache(payload)
}

const applyCopilotContextCache = (payload: ChatCompletionsPayload): void => {
  const messageIndexes = selectCopilotContextCacheMessageIndexes(
    payload.messages,
  )
  for (const messageIndex of messageIndexes) {
    const message = payload.messages[messageIndex]
    message.copilot_cache_control = { ...COPILOT_CONTEXT_CACHE_CONTROL }
  }
}

const selectCopilotContextCacheMessageIndexes = (
  messages: Array<Message>,
): Array<number> => {
  const systemIndexes = messages
    .flatMap((message, index) =>
      message.role === "system" && isCopilotContextCacheEligible(message) ?
        [index]
      : [],
    )
    .slice(0, COPILOT_CONTEXT_CACHE_SYSTEM_MARKER_LIMIT)
  const reverseNonSystemIndexes = messages
    .flatMap((message, index) =>
      message.role !== "system" && isCopilotContextCacheEligible(message) ?
        [index]
      : [],
    )
    .reverse()
    .slice(0, COPILOT_CONTEXT_CACHE_NON_SYSTEM_MARKER_LIMIT)

  return uniqueIndexes([...systemIndexes, ...reverseNonSystemIndexes]).sort(
    (a, b) => a - b,
  )
}

const isCopilotContextCacheEligible = (message: Message): boolean => {
  if (typeof message.content === "string") {
    return message.content.length > 0
  }

  return Array.isArray(message.content) && message.content.length > 0
}

const uniqueIndexes = (indexes: Array<number>): Array<number> => [
  ...new Set(indexes),
]

const isNonStreaming = (
  response: Awaited<ReturnType<typeof createChatCompletions>>,
): response is ChatCompletionResponse => Object.hasOwn(response, "choices")

const isAsyncIterable = <T>(value: unknown): value is AsyncIterable<T> =>
  Boolean(value)
  && typeof (value as AsyncIterable<T>)[Symbol.asyncIterator] === "function"

export const isClaudeModel = (model: string): boolean =>
  model.toLowerCase().startsWith("claude")

const createCopilotUsageRecorder = (options: {
  endpoint: TokenUsageEndpoint
  fallbackSessionId?: string
  model: string
  payload: AnthropicMessagesPayload
  requestSessionAffinity?: string
  requestTraceId?: string
}): ((usage: UsageTokens) => void) =>
  createCopilotTokenUsageRecorder({
    endpoint: options.endpoint,
    fallbackSessionId: options.fallbackSessionId,
    model: options.model,
    sessionId:
      options.requestSessionAffinity ?? getMetadataSessionId(options.payload),
    traceId: options.requestTraceId,
  })

const createMessagesFlowUsageRecorder = (options: {
  anthropicPayload: AnthropicMessagesPayload
  endpoint: TokenUsageEndpoint
  fallbackSessionId?: string
  model: string
  requestSessionAffinity?: string
  requestTraceId?: string
}) =>
  createCopilotUsageRecorder({
    endpoint: options.endpoint,
    fallbackSessionId: options.fallbackSessionId,
    model: options.model,
    payload: options.anthropicPayload,
    requestSessionAffinity: options.requestSessionAffinity,
    requestTraceId: options.requestTraceId,
  })

const getMetadataSessionId = (
  payload: AnthropicMessagesPayload,
): string | null => parseUserIdMetadata(payload.metadata?.user_id).sessionId

const parseAnthropicStreamEvent = (
  data: string,
): AnthropicStreamEventData | null => {
  try {
    return JSON.parse(data) as AnthropicStreamEventData
  } catch {
    return null
  }
}

const getAnthropicMessageStartUsage = (
  event: AnthropicStreamEventData,
): Parameters<typeof normalizeAnthropicUsage>[0] =>
  (
    event as {
      message?: { usage?: Parameters<typeof normalizeAnthropicUsage>[0] }
    }
  ).message?.usage
