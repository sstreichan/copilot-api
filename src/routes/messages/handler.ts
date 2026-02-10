import type { Context } from "hono"
import type { ContentfulStatusCode } from "hono/utils/http-status"

import consola from "consola"
import { streamSSE } from "hono/streaming"

import { awaitApproval } from "~/lib/approval"
import { getSmallModel, shouldCompactUseSmallModel } from "~/lib/config"
import {
  colorizeModel,
  createHandlerLogger,
  formatStreamLog,
  getPremiumInfo,
  shouldUseColor,
} from "~/lib/logger"
import { checkRateLimit } from "~/lib/rate-limit"
import { state } from "~/lib/state"
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
import { getResponsesRequestOptions } from "~/routes/responses/utils"
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
  type AnthropicTextBlock,
  type AnthropicToolResultBlock,
} from "./anthropic-types"
import {
  translateToAnthropic,
  translateToOpenAI,
} from "./non-stream-translation"
import { translateChunkToAnthropicEvents } from "./stream-translation"

const logger = createHandlerLogger("messages-handler")

const cm = (model: string) => (shouldUseColor() ? colorizeModel(model) : model)

const compactSystemPromptStart =
  "You are a helpful AI assistant tasked with summarizing conversations"

const isCompactRequest = (
  anthropicPayload: AnthropicMessagesPayload,
): boolean => {
  const system = anthropicPayload.system
  if (typeof system === "string") {
    return system.startsWith(compactSystemPromptStart)
  }
  if (!Array.isArray(system)) return false

  return system.some(
    (msg) =>
      typeof msg.text === "string"
      && msg.text.startsWith(compactSystemPromptStart),
  )
}

export async function handleCompletion(c: Context) {
  await checkRateLimit(state)

  const anthropicPayload = await c.req.json<AnthropicMessagesPayload>()
  const originalModel = anthropicPayload.model
  logger.debug("Anthropic request payload:", JSON.stringify(anthropicPayload))

  // Claude Code and OpenCode compact request detection (must be before nativeMessages branch)
  const isCompact = isCompactRequest(anthropicPayload)
  if (isCompact) {
    logger.debug("Is compact request:", isCompact)
    if (shouldCompactUseSmallModel()) {
      anthropicPayload.model = getSmallModel()
    }
  }

  // ⚠️ CRITICAL: Native Messages API branch MUST be BEFORE other payload modifications
  // This ensures payload is passed through unchanged to Copilot's /v1/messages endpoint
  // (compact detection above is the only exception - it must happen first)
  if (state.nativeMessages && isClaudeModel(anthropicPayload.model)) {
    return await handleWithNativeMessages(c, anthropicPayload, originalModel)
  }

  // fix claude code 2.0.28+ warmup request consume premium request, forcing small model if no tools are used
  // set "CLAUDE_CODE_SUBAGENT_MODEL": "you small model" also can avoid this
  const anthropicBeta = c.req.header("anthropic-beta")
  const noTools = !anthropicPayload.tools || anthropicPayload.tools.length === 0
  if (anthropicBeta && noTools && !isCompact) {
    anthropicPayload.model = getSmallModel()
  }

  // Merge tool_result and text blocks into tool_result to avoid consuming premium requests
  // (caused by skill invocations, edit hooks, plan or to do reminders)
  // e.g. {"role":"user","content":[{"type":"tool_result","content":"Launching skill: xxx"},{"type":"text","text":"xxx"}]}
  // compact requests are excluded from this processing
  if (!isCompact) {
    mergeToolResultForClaude(anthropicBeta, anthropicPayload)
  }

  const useResponsesApi = shouldUseResponsesApi(anthropicPayload.model)

  if (state.manualApprove) {
    await awaitApproval()
  }

  if (useResponsesApi) {
    return await handleWithResponsesApi(c, anthropicPayload, originalModel)
  }

  return await handleWithChatCompletions(c, anthropicPayload, originalModel)
}

const RESPONSES_ENDPOINT = "/responses"

// Helper to check if model is a Claude model (exported for testing)
export const isClaudeModel = (model: string): boolean =>
  model.toLowerCase().startsWith("claude")

// Determine initiator based on last message role (exported for testing)
export const getInitiatorFromPayload = (
  payload: AnthropicMessagesPayload,
): "user" | "agent" => {
  if (payload.messages.length === 0) return "user"
  const lastMessage = payload.messages.at(-1)
  // tool_result messages indicate agent context (responding to tool calls)
  if (
    lastMessage?.role === "user"
    && Array.isArray(lastMessage.content)
    && lastMessage.content.some((block) => block.type === "tool_result")
  ) {
    return "agent"
  }
  return lastMessage?.role === "assistant" ? "agent" : "user"
}

// Handle requests using Copilot's native /v1/messages endpoint (passthrough)
const handleWithNativeMessages = async (
  c: Context,
  anthropicPayload: AnthropicMessagesPayload,
  originalModel: string,
): Promise<Response> => {
  const anthropicBeta = c.req.header("anthropic-beta")

  consola.info(
    `IN ${cm(originalModel)} → ${cm(anthropicPayload.model)} (native)`,
  )
  logger.debug("Using native Messages API passthrough")

  if (state.manualApprove) {
    await awaitApproval()
  }

  const response = await createMessages(anthropicPayload, {
    initiator: getInitiatorFromPayload(anthropicPayload),
    anthropicBeta,
  })

  // Stream: use raw body passthrough (NOT streamSSE reconstruction)
  if (anthropicPayload.stream && response.body) {
    const premium = await getPremiumInfo()
    let chunkCount = 0
    let buffer = ""
    const decoder = new TextDecoder()
    const reader = response.body.getReader()

    const countedBody = new ReadableStream<Uint8Array>({
      async pull(controller) {
        const result = await reader.read()

        if (result.done) {
          // flush remaining buffer
          buffer += decoder.decode()
          buffer = buffer.replaceAll("\r\n", "\n")
          if (buffer.trim().length > 0) {
            chunkCount++
          }

          process.stdout.write(
            `${formatStreamLog({ model: originalModel, chunks: chunkCount, done: true, premium })}\n`,
          )
          controller.close()
          return
        }

        const chunk = result.value as Uint8Array

        // byte-for-byte passthrough
        controller.enqueue(chunk)

        // count SSE events (separated by \n\n)
        buffer += decoder.decode(chunk, { stream: true })
        buffer = buffer.replaceAll("\r\n", "\n")
        const parts = buffer.split("\n\n")
        buffer = parts.pop() ?? ""

        const newEvents = parts.filter((e) => e.trim().length > 0).length
        if (newEvents > 0) {
          chunkCount += newEvents
          process.stdout.write(
            formatStreamLog({
              model: originalModel,
              chunks: chunkCount,
              done: false,
            }),
          )
        }
      },
      cancel() {
        void reader.cancel()
      },
    })

    return c.body(countedBody, response.status as ContentfulStatusCode, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    })
  }

  // Non-stream: return JSON directly
  const jsonResponse = await response.json()
  const premium = await getPremiumInfo()
  process.stdout.write(
    `${formatStreamLog({ model: originalModel, chunks: 0, done: true, premium })}\n`,
  )
  return c.json(jsonResponse)
}

const handleWithChatCompletions = async (
  c: Context,
  anthropicPayload: AnthropicMessagesPayload,
  originalModel: string,
) => {
  const openAIPayload = translateToOpenAI(anthropicPayload)
  consola.info(`IN ${cm(originalModel)} → ${cm(openAIPayload.model)}`)
  logger.debug(
    "Translated OpenAI request payload:",
    JSON.stringify(openAIPayload),
  )

  const response = await createChatCompletions(openAIPayload)

  if (isNonStreaming(response)) {
    logger.debug(
      "Non-streaming response from Copilot:",
      JSON.stringify(response),
    )
    const anthropicResponse = translateToAnthropic(response)
    logger.debug(
      "Translated Anthropic response:",
      JSON.stringify(anthropicResponse),
    )
    const premium = await getPremiumInfo()
    process.stdout.write(
      `${formatStreamLog({ model: openAIPayload.model, chunks: 0, done: true, premium })}\n`,
    )
    return c.json(anthropicResponse)
  }

  logger.debug("Streaming response from Copilot")
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
        logger.debug("Copilot raw stream event:", JSON.stringify(rawEvent))
        if (rawEvent.data === "[DONE]") {
          break
        }

        if (!rawEvent.data) {
          continue
        }

        chunkCount++
        process.stdout.write(
          formatStreamLog({
            model: openAIPayload.model,
            chunks: chunkCount,
            done: false,
          }),
        )

        const chunk = JSON.parse(rawEvent.data) as ChatCompletionChunk
        const events = translateChunkToAnthropicEvents(chunk, streamState)

        for (const event of events) {
          logger.debug("Translated Anthropic event:", JSON.stringify(event))
          await stream.writeSSE({
            event: event.type,
            data: JSON.stringify(event),
          })
        }
      }
    } finally {
      clearInterval(pingInterval)
      const premium = await getPremiumInfo()
      process.stdout.write(
        `${formatStreamLog({ model: openAIPayload.model, chunks: chunkCount, done: true, premium })}\n`,
      )
    }
  })
}

const handleWithResponsesApi = async (
  c: Context,
  anthropicPayload: AnthropicMessagesPayload,
  originalModel: string,
) => {
  const responsesPayload =
    translateAnthropicMessagesToResponsesPayload(anthropicPayload)
  consola.info(`IN ${cm(originalModel)} → ${cm(responsesPayload.model)}`)
  logger.debug(
    "Translated Responses payload:",
    JSON.stringify(responsesPayload),
  )

  const { vision, initiator } = getResponsesRequestOptions(responsesPayload)
  const response = await createResponses(responsesPayload, {
    vision,
    initiator,
  })

  if (responsesPayload.stream && isAsyncIterable(response)) {
    logger.debug("Streaming response from Copilot (Responses API)")
    return streamSSE(c, async (stream) => {
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
          process.stdout.write(
            formatStreamLog({
              model: responsesPayload.model,
              chunks: chunkCount,
              done: false,
            }),
          )

          logger.debug("Responses raw stream event:", data)

          const events = translateResponsesStreamEvent(
            JSON.parse(data) as ResponseStreamEvent,
            streamState,
          )
          for (const event of events) {
            const eventData = JSON.stringify(event)
            logger.debug("Translated Anthropic event:", eventData)
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
        const premium = await getPremiumInfo()
        process.stdout.write(
          `${formatStreamLog({ model: responsesPayload.model, chunks: chunkCount, done: true, premium })}\n`,
        )
      }
    })
  }

  logger.debug(
    "Non-streaming Responses result:",
    JSON.stringify(response).slice(-400),
  )
  const anthropicResponse = translateResponsesResultToAnthropic(
    response as ResponsesResult,
  )
  logger.debug(
    "Translated Anthropic response:",
    JSON.stringify(anthropicResponse),
  )
  const premium = await getPremiumInfo()
  process.stdout.write(
    `${formatStreamLog({ model: responsesPayload.model, chunks: 0, done: true, premium })}\n`,
  )
  return c.json(anthropicResponse)
}

const shouldUseResponsesApi = (modelId: string): boolean => {
  const selectedModel = state.models?.data.find((model) => model.id === modelId)
  return (
    selectedModel?.supported_endpoints?.includes(RESPONSES_ENDPOINT) ?? false
  )
}

const isNonStreaming = (
  response: Awaited<ReturnType<typeof createChatCompletions>>,
): response is ChatCompletionResponse => Object.hasOwn(response, "choices")

const isAsyncIterable = <T>(value: unknown): value is AsyncIterable<T> =>
  Boolean(value)
  && typeof (value as AsyncIterable<T>)[Symbol.asyncIterator] === "function"

const mergeContentWithText = (
  tr: AnthropicToolResultBlock,
  textBlock: AnthropicTextBlock,
): AnthropicToolResultBlock => {
  if (typeof tr.content === "string") {
    return { ...tr, content: `${tr.content}\n\n${textBlock.text}` }
  }
  return {
    ...tr,
    content: [...tr.content, textBlock],
  }
}

const mergeContentWithTexts = (
  tr: AnthropicToolResultBlock,
  textBlocks: Array<AnthropicTextBlock>,
): AnthropicToolResultBlock => {
  if (typeof tr.content === "string") {
    const appendedTexts = textBlocks.map((tb) => tb.text).join("\n\n")
    return { ...tr, content: `${tr.content}\n\n${appendedTexts}` }
  }
  return { ...tr, content: [...tr.content, ...textBlocks] }
}

const mergeToolResultForClaude = (
  anthropicBeta: string | undefined,
  anthropicPayload: AnthropicMessagesPayload,
): void => {
  if (!anthropicBeta) return

  for (const msg of anthropicPayload.messages) {
    if (msg.role !== "user" || !Array.isArray(msg.content)) continue

    const toolResults: Array<AnthropicToolResultBlock> = []
    const textBlocks: Array<AnthropicTextBlock> = []
    let valid = true

    for (const block of msg.content) {
      if (block.type === "tool_result") {
        toolResults.push(block)
      } else if (block.type === "text") {
        textBlocks.push(block)
      } else {
        valid = false
        break
      }
    }

    if (!valid || toolResults.length === 0 || textBlocks.length === 0) continue

    msg.content = mergeToolResult(toolResults, textBlocks)
  }
}

const mergeToolResult = (
  toolResults: Array<AnthropicToolResultBlock>,
  textBlocks: Array<AnthropicTextBlock>,
): Array<AnthropicToolResultBlock> => {
  // equal lengths -> pairwise merge
  if (toolResults.length === textBlocks.length) {
    return toolResults.map((tr, i) => mergeContentWithText(tr, textBlocks[i]))
  }

  // lengths differ -> append all textBlocks to the last tool_result
  const lastIndex = toolResults.length - 1
  return toolResults.map((tr, i) =>
    i === lastIndex ? mergeContentWithTexts(tr, textBlocks) : tr,
  )
}
