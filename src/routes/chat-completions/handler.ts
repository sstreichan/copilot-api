import consola from "consola"
import type { Context } from "hono"

import { streamSSE, type SSEMessage } from "hono/streaming"

import { awaitApproval } from "~/lib/approval"
import { resolveMappedModel } from "~/lib/config"
import {
  createHandlerLogger,
  debugJson,
  debugJsonTail,
  resolvePremiumInfo,
  writeStreamLog,
} from "~/lib/logger"
import { parseProviderModelAlias } from "~/lib/provider-model"
import { checkRateLimit } from "~/lib/rate-limit"
import {
  applyForwardableResponseHeaders,
  getAttachedResponseHeaders,
  jsonWithForwardedHeaders,
} from "~/lib/response-headers"
import { state } from "~/lib/state"
import {
  createCopilotTokenUsageRecorder,
  normalizeOpenAIUsage,
  type UsageTokens,
} from "~/lib/token-usage"
import { generateRequestIdFromPayload, getUUID, isNullish } from "~/lib/utils"
import { handleProviderChatCompletionsForProvider } from "~/routes/provider/chat-completions/handler"
import {
  createChatCompletions,
  type ChatCompletionChunk,
  type ChatCompletionResponse,
  type ChatCompletionsPayload,
} from "~/services/copilot/create-chat-completions"

const logger = createHandlerLogger("chat-completions-handler")

export async function handleCompletion(c: Context) {
  let payload = await c.req.json<ChatCompletionsPayload>()
  const requestedModel = payload.model
  payload.model = resolveMappedModel(payload.model)
  if (payload.model !== requestedModel) {
    consola.debug(
      `Resolved model mapping: ${requestedModel} -> ${payload.model}`,
    )
  }

  const providerModelAlias = parseProviderModelAlias(payload.model)
  if (providerModelAlias) {
    payload.model = providerModelAlias.model
    return await handleProviderChatCompletionsForProvider(c, {
      payload,
      provider: providerModelAlias.provider,
    })
  }

  await checkRateLimit(state)

  debugJsonTail(logger, "Request payload:", { value: payload, tailLength: 400 })

  // Find the selected model
  const selectedModel = state.models?.data.find(
    (model) => model.id === payload.model,
  )

  if (selectedModel?.id === "gpt-5.4") {
    return c.json(
      {
        error: {
          message: "Please use `/v1/responses` or `/v1/messages` API",
          type: "invalid_request_error",
        },
      },
      400,
    )
  }

  if (state.manualApprove) await awaitApproval()

  if (isNullish(payload.max_tokens)) {
    payload = {
      ...payload,
      max_tokens: selectedModel?.capabilities.limits.max_output_tokens,
    }
    debugJson(logger, "Set max_tokens to:", payload.max_tokens)
  }

  // not support subagent marker for now , set sessionId = getUUID(requestId)
  const requestId = generateRequestIdFromPayload(payload)
  logger.debug("Generated request ID:", requestId)

  const sessionId = getUUID(requestId)
  logger.debug("Extracted session ID:", sessionId)
  const recordUsage = createCopilotTokenUsageRecorder({
    endpoint: "chat_completions",
    fallbackSessionId: sessionId,
    model: payload.model,
  })

  const response = await createChatCompletions(payload, {
    requestId,
    sessionId,
  })

  if (isNonStreaming(response)) {
    debugJson(logger, "Non-streaming response:", response)
    recordUsage(normalizeOpenAIUsage(response.usage))
    const premium = await resolvePremiumInfo(
      response,
      "chat-completions/non-stream",
    )
    writeStreamLog(
      { model: payload.model, chunks: 0, done: true, premium },
      true,
    )
    return jsonWithForwardedHeaders(
      response,
      getAttachedResponseHeaders(response),
    )
  }

  logger.debug("Streaming response")
  applyForwardableResponseHeaders(c, getAttachedResponseHeaders(response), {
    "content-type": null,
    "cache-control": null,
    connection: null,
  })
  return streamSSE(c, async (stream) => {
    let chunkCount = 0
    let usage: UsageTokens = {}
    try {
      for await (const chunk of response) {
        debugJson(logger, "Streaming chunk:", chunk)

        // Check for [DONE] marker
        const sseChunk = chunk as SSEMessage
        const chunkData = normalizeSSEData(await sseChunk.data)
        if (chunkData === "[DONE]") {
          await stream.writeSSE({ ...sseChunk, data: chunkData })
          break
        }

        if (chunkData === undefined) {
          continue
        }

        chunkCount++
        const parsedChunk = parseChatCompletionChunk(chunkData)
        if (parsedChunk?.usage) {
          usage = normalizeOpenAIUsage(parsedChunk.usage)
        }

        await stream.writeSSE({ ...sseChunk, data: chunkData })
      }
    } finally {
      const premium = await resolvePremiumInfo(
        response,
        "chat-completions/stream",
      )
      writeStreamLog(
        { model: payload.model, chunks: chunkCount, done: true, premium },
        true,
      )
      recordUsage(usage)
    }
  })
}

const isNonStreaming = (
  response: Awaited<ReturnType<typeof createChatCompletions>>,
): response is ChatCompletionResponse => Object.hasOwn(response, "choices")

const parseChatCompletionChunk = (
  data: string | undefined,
): ChatCompletionChunk | null => {
  if (!data || data === "[DONE]") {
    return null
  }

  try {
    return JSON.parse(data) as ChatCompletionChunk
  } catch {
    return null
  }
}

const normalizeSSEData = (data: string | undefined): string | undefined => {
  if (!data?.startsWith("data:")) {
    return data
  }

  return data
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .join("\n")
}
