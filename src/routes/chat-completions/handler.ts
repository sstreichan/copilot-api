import type { Context } from "hono"

import { streamSSE, type SSEMessage } from "hono/streaming"

import { awaitApproval } from "~/lib/approval"
import {
  createHandlerLogger,
  debugJson,
  debugJsonTail,
  resolvePremiumInfo,
  writeStreamLog,
} from "~/lib/logger"
import { checkRateLimit } from "~/lib/rate-limit"
import { state } from "~/lib/state"
import { generateRequestIdFromPayload, getUUID, isNullish } from "~/lib/utils"
import {
  createChatCompletions,
  type ChatCompletionResponse,
  type ChatCompletionsPayload,
} from "~/services/copilot/create-chat-completions"

const logger = createHandlerLogger("chat-completions-handler")

export async function handleCompletion(c: Context) {
  await checkRateLimit(state)

  let payload = await c.req.json<ChatCompletionsPayload>()
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

  const response = await createChatCompletions(payload, {
    requestId,
    sessionId,
  })

  if (isNonStreaming(response)) {
    debugJson(logger, "Non-streaming response:", response)
    const premium = await resolvePremiumInfo(
      response,
      "chat-completions/non-stream",
    )
    writeStreamLog(
      { model: payload.model, chunks: 0, done: true, premium },
      true,
    )
    return c.json(response)
  }

  logger.debug("Streaming response")
  return streamSSE(c, async (stream) => {
    let chunkCount = 0
    try {
      for await (const chunk of response) {
        debugJson(logger, "Streaming chunk:", chunk)

        chunkCount++
        // Check for [DONE] marker
        const sseChunk = chunk as SSEMessage
        if (sseChunk.data === "[DONE]") {
          await stream.writeSSE(sseChunk)
          break
        }

        await stream.writeSSE(sseChunk)
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
    }
  })
}

const isNonStreaming = (
  response: Awaited<ReturnType<typeof createChatCompletions>>,
): response is ChatCompletionResponse => Object.hasOwn(response, "choices")
