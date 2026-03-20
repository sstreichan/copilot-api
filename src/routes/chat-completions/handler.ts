import type { Context } from "hono"

import { streamSSE, type SSEMessage } from "hono/streaming"

import { awaitApproval } from "~/lib/approval"
import {
  createHandlerLogger,
  formatStreamLog,
  resolvePremiumInfo,
} from "~/lib/logger"
import { checkRateLimit } from "~/lib/rate-limit"
import { state } from "~/lib/state"
import { getTokenCount } from "~/lib/tokenizer"
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
  logger.debug("Request payload:", JSON.stringify(payload).slice(-400))

  // Find the selected model
  const selectedModel = state.models?.data.find(
    (model) => model.id === payload.model,
  )

  // Calculate and display token count
  try {
    if (selectedModel) {
      const tokenCount = await getTokenCount(payload, selectedModel)
      logger.info("Current token count:", tokenCount)
    } else {
      logger.warn("No model selected, skipping token count calculation")
    }
  } catch (error) {
    logger.warn("Failed to calculate token count:", error)
  }

  if (state.manualApprove) await awaitApproval()

  if (isNullish(payload.max_tokens)) {
    payload = {
      ...payload,
      max_tokens: selectedModel?.capabilities.limits.max_output_tokens,
    }
    logger.debug("Set max_tokens to:", JSON.stringify(payload.max_tokens))
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
    logger.debug("Non-streaming response:", JSON.stringify(response))
    const premium = await resolvePremiumInfo(
      response,
      "chat-completions/non-stream",
    )
    process.stdout.write(
      `${formatStreamLog({ model: payload.model, chunks: 0, done: true, premium })}\n`,
    )
    return c.json(response)
  }

  logger.debug("Streaming response")
  return streamSSE(c, async (stream) => {
    let chunkCount = 0
    try {
      for await (const chunk of response) {
        logger.debug("Streaming chunk:", JSON.stringify(chunk))

        chunkCount++
        process.stdout.write(
          formatStreamLog({
            model: payload.model,
            chunks: chunkCount,
            done: false,
          }),
        )

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
      process.stdout.write(
        `${formatStreamLog({ model: payload.model, chunks: chunkCount, done: true, premium })}\n`,
      )
    }
  })
}

const isNonStreaming = (
  response: Awaited<ReturnType<typeof createChatCompletions>>,
): response is ChatCompletionResponse => Object.hasOwn(response, "choices")
