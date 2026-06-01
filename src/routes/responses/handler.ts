import type { Context } from "hono"

import consola from "consola"
import { streamSSE } from "hono/streaming"

import type { Model } from "~/services/copilot/get-models"

import { awaitApproval } from "~/lib/approval"
import {
  getConfig as getConfiguredConfig,
  isResponsesApiWebSearchEnabled as isConfiguredResponsesApiWebSearchEnabled,
  resolveEffortForLog,
  resolveMappedModel,
} from "~/lib/config"
import { HTTPError } from "~/lib/error"
import {
  colorizeModel,
  createHandlerLogger,
  debugJson,
  debugJsonTail,
  resolvePremiumInfo,
  shouldUseColor,
  writeStreamLog,
} from "~/lib/logger"
import { findEndpointModel } from "~/lib/models"
import { parseProviderModelAlias } from "~/lib/provider-model"
import { checkRateLimit as checkConfiguredRateLimit } from "~/lib/rate-limit"
import {
  applyForwardableResponseHeaders,
  getAttachedResponseHeaders,
  jsonWithForwardedHeaders,
} from "~/lib/response-headers"
import { handleProviderResponsesForProvider } from "~/routes/provider/responses/handler"
import { state } from "~/lib/state"
import {
  createCopilotTokenUsageRecorder,
  mergeAnthropicUsage,
  normalizeAnthropicUsage,
  normalizeOpenAIUsage,
  normalizeResponsesUsage,
  type UsageTokens,
} from "~/lib/token-usage"
import type { SubagentMarker } from "~/lib/subagent"
import {
  generateRequestIdFromPayload,
  getRootSessionIdFromResponsesPayload,
  getStableSessionKeyFromResponsesPayload,
  getUUID,
} from "~/lib/utils"
import {
  createChatCompletions,
  type ChatCompletionChunk,
  type ChatCompletionResponse,
} from "~/services/copilot/create-chat-completions"
import { createMessages } from "~/services/copilot/create-messages"
import {
  createResponses,
  type Reasoning,
  type ResponsesPayload,
  type ResponsesResult,
  type ResponseStreamEvent,
} from "~/services/copilot/create-responses"

import type { AnthropicStreamEventData } from "../messages/anthropic-types"

import { preflightResponsesPayload } from "./preflight"
import {
  createChatCompletionToResponsesStreamState,
  translateChatCompletionChunkToResponsesStreamEvents,
  translateChatCompletionStreamErrorToResponsesEvent,
  translateChatCompletionToResponsesResult,
  translateResponsesToChatCompletions,
} from "./responses-from-chat"
import {
  createAnthropicToResponsesStreamState,
  translateAnthropicMessageToResponses,
  translateAnthropicStreamEventToResponsesStreamEvents,
  translateResponsesToAnthropicMessages,
} from "./responses-from-messages"
import { createStreamIdTracker, fixStreamIds } from "./stream-id-sync"
import {
  applyResponsesApiContextManagement,
  getResponsesTransportForModel,
  getResponsesRequestOptions,
  sanitizeAllInputImages,
  sanitizeOversizedInputImages,
} from "./utils"

export { removeUnsupportedTools } from "./preflight"

const logger = createHandlerLogger("responses-handler")

const cm = (model: string) => (shouldUseColor() ? colorizeModel(model) : model)

const RESPONSES_ENDPOINT = "/responses"
const MESSAGES_ENDPOINT = "/v1/messages"

type ResponsesHandlerContext = {
  payload: ResponsesPayload
  recordUsage: ResponsesUsageRecorder
  requestId: string
  sessionId: string
}

type ResponsesUsageRecorder = (usage: UsageTokens) => void

type CopilotResponsesContext = {
  c: Context
  payload: ResponsesPayload
  selectedModel: Model
  requestId: string
  sessionId: string
  recordUsage: ResponsesUsageRecorder
  subagentMarker: SubagentMarker | null
}
export const responsesHandlerDependencies = {
  checkRateLimit: checkConfiguredRateLimit,
  createResponses,
  getConfig: getConfiguredConfig,
  isResponsesApiWebSearchEnabled: isConfiguredResponsesApiWebSearchEnabled,
}

export const handleResponses = async (c: Context) => {
  const payload = await c.req.json<ResponsesPayload>()
  const requestedModel = payload.model
  payload.model = resolveMappedModel(payload.model)
  if (payload.model !== requestedModel) {
    logger.debug(
      `Resolved model mapping: ${requestedModel} -> ${payload.model}`,
    )
  }

  const providerModelAlias = parseProviderModelAlias(payload.model)
  if (providerModelAlias) {
    payload.model = providerModelAlias.model
    return await handleProviderResponsesForProvider(c, {
      payload,
      provider: providerModelAlias.provider,
    })
  }

  debugJson(logger, "Responses request payload:", payload)
  await responsesHandlerDependencies.checkRateLimit(state)

  const stableSessionKey = getStableSessionKeyFromResponsesPayload(payload, c)
  if (!payload.prompt_cache_key?.trim() && stableSessionKey) {
    payload.prompt_cache_key = stableSessionKey
  }

  const subagentMarker = getCodexResponsesSubagentMarker(c)
  if (subagentMarker) {
    debugJson(logger, "Detected Codex subagent headers:", subagentMarker)
  }

  const rootSessionId = getRootSessionIdFromResponsesPayload(payload, c)
  logger.debug("Extracted root session ID:", rootSessionId)

  const incomingSessionId =
    subagentMarker ? getIncomingResponsesSessionId(c) : undefined

  // subagent 的 incoming session（裸 header 值）需经 getUUID 规整；否则用
  // dev 的 rootSessionId（getRootSessionIdFromResponsesPayload 内部已 getUUID）
  const sessionSeed =
    incomingSessionId ? getUUID(incomingSessionId) : rootSessionId
  const requestId = generateRequestIdFromPayload(
    { messages: payload.input },
    sessionSeed,
  )
  logger.debug("Generated request ID:", requestId)

  const fallbackSessionId = sessionSeed ?? getUUID(requestId)
  logger.debug("Extracted session ID:", fallbackSessionId)
  const sessionId = fallbackSessionId
  const recordUsage = createCopilotTokenUsageRecorder({
    endpoint: "responses",
    fallbackSessionId,
    model: payload.model,
  })

  preflightResponsesPayload(payload)

  const selectedModel = findEndpointModel(payload.model)
  if (!selectedModel) {
    return c.json(
      {
        error: {
          message: `Model '${payload.model}' is not supported by /v1/responses`,
          type: "invalid_request_error",
          code: "model_not_found",
          param: "model",
        },
      },
      400,
    )
  }
  payload.model = selectedModel.id

  // Path A: model supports /responses → native Copilot Responses API
  if (selectedModel.supported_endpoints?.includes(RESPONSES_ENDPOINT)) {
    const responsesTransport = getResponsesTransportForModel(selectedModel)
    if (!responsesTransport) {
      return c.json(
        {
          error: {
            message: `Model '${payload.model}' is not supported by /v1/responses`,
            type: "invalid_request_error",
            code: "model_not_found",
            param: "model",
          },
        },
        400,
      )
    }

    return handleWithCopilotResponses({
      c,
      payload,
      selectedModel,
      requestId,
      sessionId,
      recordUsage,
      subagentMarker,
    })
  }

  // Path B: model supports /v1/messages → messages backend
  if (selectedModel.supported_endpoints?.includes(MESSAGES_ENDPOINT)) {
    return handleWithMessagesBackend(c, {
      payload,
      recordUsage,
      requestId,
      sessionId,
    })
  }

  // Path C: generic fallback → chat completions bridge
  return handleWithChatFallback(c, {
    payload,
    recordUsage,
    requestId,
    sessionId,
  })
}

const handleWithMessagesBackend = async (
  c: Context,
  { payload, recordUsage, requestId, sessionId }: ResponsesHandlerContext,
) => {
  const anthropicPayload = translateResponsesToAnthropicMessages(payload)

  consola.info(`IN ${cm(payload.model)} [messages-backend]`)

  if (state.manualApprove) {
    await awaitApproval()
  }

  const { initiator } = getResponsesRequestOptions(payload)

  let response: Awaited<ReturnType<typeof createMessages>>
  try {
    response = await createMessages(anthropicPayload, {
      initiator,
      requestId,
      sessionId,
    })
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Messages backend failed"
    return c.json({ error: { message, type: "server_error" } }, 500)
  }

  if (isStreamingRequested(payload)) {
    applyStreamingHeaders(c, response)

    return streamSSE(c, async (stream) => {
      const streamState = createAnthropicToResponsesStreamState()
      let chunkCount = 0
      let usage: UsageTokens = {}
      try {
        for await (const event of parseAnthropicSSEBody(response.body)) {
          usage = mergeAnthropicStreamUsage(usage, event)
          await writeAnthropicStreamEvents(stream, event, streamState)
          chunkCount++
        }
      } catch (err) {
        await writeResponsesStreamError(
          stream,
          createPathBStreamErrorEvent(payload.model, err),
        )
      } finally {
        const premium = await resolvePremiumInfo(
          response,
          "responses/path-b/stream",
        )
        writeStreamLog(
          { model: payload.model, chunks: chunkCount, done: true, premium },
          true,
        )
        recordUsage(usage)
        if (!stream.closed) {
          await stream.close()
        }
      }
    })
  }

  // Non-stream path
  let jsonResponse: unknown
  try {
    jsonResponse = await response.json()
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Failed to parse response"
    return c.json({ error: { message, type: "server_error" } }, 500)
  }

  const result = translateAnthropicMessageToResponses(
    jsonResponse as Parameters<typeof translateAnthropicMessageToResponses>[0],
  )
  recordUsage(normalizeResponsesUsage(result.usage))
  debugJsonTail(logger, "Path B non-stream result:", {
    value: result,
    tailLength: 400,
  })
  const premium = await resolvePremiumInfo(
    response,
    "responses/path-b/non-stream",
  )
  writeStreamLog({ model: payload.model, chunks: 0, done: true, premium }, true)
  return jsonWithForwardedHeaders(
    result,
    getAttachedResponseHeaders(response) ?? response.headers,
  )
}

const handleWithChatFallback = async (
  c: Context,
  { payload, recordUsage, requestId, sessionId }: ResponsesHandlerContext,
) => {
  const chatPayload = translateResponsesToChatCompletions(payload)

  consola.info(`IN ${cm(payload.model)} [chat-fallback]`)

  if (state.manualApprove) {
    await awaitApproval()
  }

  let response: Awaited<ReturnType<typeof createChatCompletions>>
  try {
    response = await createChatCompletions(chatPayload, {
      requestId,
      sessionId,
    })
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Chat completions fallback failed"
    return c.json({ error: { message, type: "server_error" } }, 500)
  }

  if (isStreamingRequested(payload)) {
    applyForwardableResponseHeaders(c, getAttachedResponseHeaders(response), {
      "content-type": null,
      "cache-control": null,
      connection: null,
    })
    return streamSSE(c, async (stream) => {
      const streamState = createChatCompletionToResponsesStreamState()
      let usage: UsageTokens = {}
      try {
        for await (const chunk of response as AsyncIterable<{
          data?: string
        }>) {
          if (chunk.data === "[DONE]") break
          if (!chunk.data) continue
          let parsed: ChatCompletionChunk
          try {
            parsed = JSON.parse(chunk.data) as ChatCompletionChunk
          } catch {
            continue
          }
          if (parsed.usage) {
            usage = normalizeOpenAIUsage(parsed.usage)
          }
          const sseEvents = translateChatCompletionChunkToResponsesStreamEvents(
            parsed,
            streamState,
          )
          for (const ev of sseEvents) {
            debugJson(logger, "Path C stream event:", ev)
            await stream.writeSSE({ event: ev.type, data: JSON.stringify(ev) })
          }
        }
      } catch (err) {
        const errorEvent = translateChatCompletionStreamErrorToResponsesEvent(
          err,
          streamState,
        )
        try {
          await stream.writeSSE({
            event: errorEvent.type,
            data: JSON.stringify(errorEvent),
          })
        } catch {
          // stream already closed
        }
      } finally {
        const premium = await resolvePremiumInfo(
          response,
          "responses/path-c/stream",
        )
        writeStreamLog(
          { model: payload.model, chunks: 0, done: true, premium },
          true,
        )
        recordUsage(usage)
        if (!stream.closed) {
          await stream.close()
        }
      }
    })
  }

  // Non-stream
  const chatResult = response as ChatCompletionResponse
  const responsesResult = translateChatCompletionToResponsesResult(chatResult)
  recordUsage(normalizeOpenAIUsage(chatResult.usage))
  debugJsonTail(logger, "Path C non-stream result:", {
    value: responsesResult,
    tailLength: 400,
  })
  const premium = await resolvePremiumInfo(
    response,
    "responses/path-c/non-stream",
  )
  writeStreamLog({ model: payload.model, chunks: 0, done: true, premium }, true)
  return jsonWithForwardedHeaders(
    responsesResult,
    getAttachedResponseHeaders(response),
  )
}
const handleWithCopilotResponses = async ({
  c,
  payload,
  selectedModel,
  requestId,
  sessionId,
  recordUsage,
  subagentMarker,
}: CopilotResponsesContext) => {
  const sanitizedImageCount = sanitizeOversizedInputImages(
    payload,
    selectedModel?.capabilities.limits.vision?.max_prompt_image_size,
  )
  if (sanitizedImageCount > 0) {
    logger.warn(
      `Omitted ${sanitizedImageCount} oversized input image(s) before forwarding to Copilot Responses`,
    )
  }

  // Smaller than the client compaction threshold, use server-side compaction to maintain cache hit rate
  const maxPromptTokens = selectedModel?.capabilities.limits.max_prompt_tokens
  applyResponsesApiContextManagement(payload, maxPromptTokens, 0.8)

  debugJson(logger, "Translated Responses payload:", payload)

  const { vision, initiator: inferredInitiator } =
    getResponsesRequestOptions(payload)
  const initiator = subagentMarker ? "agent" : inferredInitiator
  const transport = getResponsesTransportForModel(selectedModel, {}) ?? "http"

  const effortForLog = ensureReasoningEffort(payload)

  consola.info(
    `IN ${cm(payload.model)} [effort=${effortForLog.value} (${effortForLog.source})]`,
  )

  if (state.manualApprove) {
    await awaitApproval()
  }

  const responseOptions = {
    vision,
    initiator,
    subagentMarker,
    requestId,
    sessionId,
    transport,
  }
  let response: Awaited<ReturnType<typeof createResponses>>
  try {
    response = await responsesHandlerDependencies.createResponses(
      payload,
      responseOptions,
    )
  } catch (error) {
    if (!(error instanceof HTTPError) || error.response.status !== 413) {
      throw error
    }

    const retrySanitizedImageCount = sanitizeAllInputImages(payload)
    if (retrySanitizedImageCount === 0) {
      throw error
    }

    logger.warn(
      `Omitted ${retrySanitizedImageCount} input image(s) after Copilot Responses rejected the payload as too large`,
    )
    const retryOptions = {
      ...responseOptions,
      vision: getResponsesRequestOptions(payload).vision,
    }
    response = await responsesHandlerDependencies.createResponses(
      payload,
      retryOptions,
    )
  }

  if (isStreamingRequested(payload) && isAsyncIterable(response)) {
    return handleStreamingResponse({
      c,
      model: payload.model,
      recordUsage,
      response,
    })
  }

  debugJsonTail(logger, "Forwarding native Responses result:", {
    value: response,
    tailLength: 400,
  })
  recordUsage(normalizeResponsesUsage((response as ResponsesResult).usage))
  const premium = await resolvePremiumInfo(response, "responses/non-stream")
  writeStreamLog({ model: payload.model, chunks: 0, done: true, premium }, true)
  return jsonWithForwardedHeaders(
    response as ResponsesResult,
    getAttachedResponseHeaders(response),
  )
}

const isAsyncIterable = <T>(value: unknown): value is AsyncIterable<T> =>
  Boolean(value)
  && typeof (value as AsyncIterable<T>)[Symbol.asyncIterator] === "function"

const handleStreamingResponse = (options: {
  c: Context
  model: string
  recordUsage: ResponsesUsageRecorder
  response: AsyncIterable<unknown>
}) => {
  const { c, model, recordUsage, response } = options
  logger.debug("Forwarding native Responses stream")
  applyForwardableResponseHeaders(c, getAttachedResponseHeaders(response), {
    "content-type": null,
    "cache-control": null,
    connection: null,
  })

  return streamSSE(c, async (stream) => {
    let chunkCount = 0
    const idTracker = createStreamIdTracker()
    let usage: UsageTokens = {}

    try {
      for await (const chunk of response) {
        debugJson(logger, "Responses stream chunk:", chunk)
        chunkCount++
        const parsedEvent = parseResponsesStreamEvent(chunk)
        if (
          parsedEvent?.type === "response.completed"
          || parsedEvent?.type === "response.failed"
          || parsedEvent?.type === "response.incomplete"
        ) {
          usage = normalizeResponsesUsage(getResponsesStreamUsage(parsedEvent))
        }
        const processedData = fixStreamIds(
          (chunk as { data?: string }).data ?? "",
          (chunk as { event?: string }).event,
          idTracker,
        )

        await stream.writeSSE({
          id: (chunk as { id?: string }).id,
          event: (chunk as { event?: string }).event,
          data: processedData,
        })
      }
    } finally {
      const premium = await resolvePremiumInfo(response, "responses/stream")
      writeStreamLog({ model, chunks: chunkCount, done: true, premium }, true)
      recordUsage(usage)
      if (!stream.closed) {
        await stream.close()
      }
    }
  })
}

const applyStreamingHeaders = (c: Context, response: { headers?: Headers }) => {
  applyForwardableResponseHeaders(
    c,
    getAttachedResponseHeaders(response) ?? response.headers,
    {
      "content-type": null,
      "cache-control": null,
      connection: null,
    },
  )
}

const writeAnthropicStreamEvents = async (
  stream: Parameters<Parameters<typeof streamSSE>[1]>[0],
  event: AnthropicStreamEventData,
  streamState: ReturnType<typeof createAnthropicToResponsesStreamState>,
) => {
  const sseEvents = translateAnthropicStreamEventToResponsesStreamEvents(
    event,
    streamState,
  )
  for (const ev of sseEvents) {
    debugJson(logger, "Path B stream event:", ev)
    await stream.writeSSE({
      event: ev.type,
      data: JSON.stringify(ev),
    })
  }
}

const createPathBStreamErrorEvent = (model: string, err: unknown) => {
  const message = err instanceof Error ? err.message : "Stream error"
  return {
    type: "response.failed",
    sequence_number: 0,
    response: {
      id: "resp_stream_error",
      object: "response",
      created_at: Math.floor(Date.now() / 1000),
      model,
      output: [],
      output_text: "",
      status: "failed",
      error: { message },
      incomplete_details: null,
      instructions: null,
      metadata: null,
      parallel_tool_calls: false,
      temperature: null,
      tool_choice: "auto",
      tools: [],
      top_p: null,
      usage: null,
    },
  }
}

const mergeAnthropicStreamUsage = (
  current: UsageTokens,
  event: AnthropicStreamEventData,
): UsageTokens => {
  if (event.type === "message_start") {
    return mergeAnthropicUsage(
      current,
      normalizeAnthropicUsage(getAnthropicMessageStartUsage(event)),
    )
  }

  if (event.type === "message_delta") {
    return mergeAnthropicUsage(current, normalizeAnthropicUsage(event.usage))
  }

  return current
}

const getAnthropicMessageStartUsage = (
  event: AnthropicStreamEventData,
): Parameters<typeof normalizeAnthropicUsage>[0] => {
  const messageStart = event as { message?: { usage?: unknown } }
  return messageStart.message?.usage as Parameters<
    typeof normalizeAnthropicUsage
  >[0]
}

const writeResponsesStreamError = async (
  stream: Parameters<Parameters<typeof streamSSE>[1]>[0],
  errorEvent: ReturnType<typeof createPathBStreamErrorEvent>,
) => {
  try {
    await stream.writeSSE({
      event: errorEvent.type,
      data: JSON.stringify(errorEvent),
    })
  } catch {
    // stream already closed
  }
}

const ensureReasoningEffort = (
  payload: ResponsesPayload,
): ReturnType<typeof resolveEffortForLog> => {
  const effortForLog = resolveEffortForLog(
    payload.reasoning?.effort ?? undefined,
    payload.model,
  )

  if (!payload.reasoning?.effort) {
    payload.reasoning = {
      ...payload.reasoning,
      effort: effortForLog.value as NonNullable<Reasoning>["effort"],
    }
  }

  return effortForLog
}

const isStreamingRequested = (payload: ResponsesPayload): boolean =>
  Boolean(payload.stream)

const parseResponsesStreamEvent = (
  chunk: unknown,
): ResponseStreamEvent | null => {
  const data = (chunk as { data?: string }).data
  if (!data || data === "[DONE]") {
    return null
  }

  try {
    return JSON.parse(data) as ResponseStreamEvent
  } catch {
    return null
  }
}

const getResponsesStreamUsage = (
  event: ResponseStreamEvent,
): Parameters<typeof normalizeResponsesUsage>[0] =>
  (
    event as {
      response?: { usage?: Parameters<typeof normalizeResponsesUsage>[0] }
    }
  ).response?.usage

const parseAnthropicSSEBody = async function* (
  body: ReadableStream<Uint8Array> | null,
) {
  if (!body) {
    return
  }

  const reader = body.getReader()
  const decoder = new TextDecoder()
  const bufferState = { value: "" }

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      bufferState.value += decoder.decode(value, { stream: true })

      while (true) {
        const nextEvent = consumeAnthropicSSEEvent(bufferState)
        if (nextEvent === null) {
          break
        }
        if (!nextEvent || nextEvent === "[DONE]") {
          continue
        }

        yield parseAnthropicSSEData(nextEvent)
      }
    }

    const rest = extractAnthropicSSEData(
      `${bufferState.value}${decoder.decode()}`,
    )
    if (!rest) {
      return
    }

    if (rest === "[DONE]") {
      return
    }

    yield parseAnthropicSSEData(rest)
  } finally {
    reader.releaseLock()
  }
}

const consumeAnthropicSSEEvent = (bufferRef: {
  value: string
}): string | null => {
  const boundaryIndex = bufferRef.value.indexOf("\n\n")
  if (boundaryIndex === -1) {
    return null
  }

  const rawEvent = bufferRef.value.slice(0, boundaryIndex)
  bufferRef.value = bufferRef.value.slice(boundaryIndex + 2)
  return extractAnthropicSSEData(rawEvent)
}

const extractAnthropicSSEData = (rawEvent: string): string => {
  const lines = rawEvent.split("\n").map((line) => line.replace(/\r$/, ""))
  let data = ""
  for (const line of lines) {
    if (line.startsWith("data:")) {
      data += `${line.slice(5).trimStart()}\n`
    }
  }

  return data.trim()
}

const parseAnthropicSSEData = (data: string): AnthropicStreamEventData =>
  JSON.parse(data) as AnthropicStreamEventData

const getIncomingResponsesSessionId = (c: Context): string | undefined =>
  getTrimmedHeader(c, "session-id") ?? getTrimmedHeader(c, "x-session-id")

const codexSubagentHeaderValues = new Set([
  "collab_spawn",
  "compact",
  "memory_consolidation",
  "review",
])

const getCodexResponsesSubagentMarker = (c: Context): SubagentMarker | null => {
  const agentType = getTrimmedHeader(c, "x-openai-subagent")
  if (!agentType || !codexSubagentHeaderValues.has(agentType)) {
    return null
  }

  const threadId = getTrimmedHeader(c, "thread-id")
  const rootSessionId = getIncomingResponsesSessionId(c)
  const parentThreadId = getTrimmedHeader(c, "x-codex-parent-thread-id")
  if (!threadId && !rootSessionId && !parentThreadId) {
    return null
  }

  const agentId = threadId ?? parentThreadId ?? rootSessionId ?? agentType

  return {
    agent_id: agentId,
    agent_type: agentType,
    session_id: threadId ?? rootSessionId ?? agentId,
  }
}

const getTrimmedHeader = (c: Context, name: string): string | undefined => {
  const value = c.req.header(name)?.trim()
  return value || undefined
}
