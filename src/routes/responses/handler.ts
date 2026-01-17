import type { Context } from "hono"

import consola from "consola"
import { streamSSE } from "hono/streaming"

import { awaitApproval } from "~/lib/approval"
import { getConfig } from "~/lib/config"
import {
  createHandlerLogger,
  formatStreamLog,
  getPremiumInfo,
} from "~/lib/logger"
import { checkRateLimit } from "~/lib/rate-limit"
import { state } from "~/lib/state"
import {
  createResponses,
  type ResponsesPayload,
  type ResponsesResult,
} from "~/services/copilot/create-responses"

import { getResponsesRequestOptions } from "./utils"

const logger = createHandlerLogger("responses-handler")

const RESPONSES_ENDPOINT = "/responses"

export const handleResponses = async (c: Context) => {
  await checkRateLimit(state)

  const payload = await c.req.json<ResponsesPayload>()
  logger.debug("Responses request payload:", JSON.stringify(payload))

  useFunctionApplyPatch(payload)

  const selectedModel = state.models?.data.find(
    (model) => model.id === payload.model,
  )
  const supportsResponses =
    selectedModel?.supported_endpoints?.includes(RESPONSES_ENDPOINT) ?? false

  if (!supportsResponses) {
    return c.json(
      {
        error: {
          message:
            "This model does not support the responses endpoint. Please choose a different model.",
          type: "invalid_request_error",
        },
      },
      400,
    )
  }

  const { vision, initiator } = getResponsesRequestOptions(payload)

  consola.info(`IN ${payload.model}`)

  if (state.manualApprove) {
    await awaitApproval()
  }

  const response = await createResponses(payload, { vision, initiator })

  if (isStreamingRequested(payload) && isAsyncIterable(response)) {
    logger.debug("Forwarding native Responses stream")
    return streamSSE(c, async (stream) => {
      let chunkCount = 0
      const idTracker = createStreamIdTracker()

      try {
        for await (const chunk of response) {
          logger.debug("Responses stream chunk:", JSON.stringify(chunk))
          chunkCount++
          process.stdout.write(
            formatStreamLog({
              model: payload.model,
              chunks: chunkCount,
              done: false,
            }),
          )

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
        const premium = await getPremiumInfo()
        process.stdout.write(
          `${formatStreamLog({ model: payload.model, chunks: chunkCount, done: true, premium })}\n`,
        )
      }
    })
  }

  logger.debug(
    "Forwarding native Responses result:",
    JSON.stringify(response).slice(-400),
  )
  const premium = await getPremiumInfo()
  process.stdout.write(
    `${formatStreamLog({ model: payload.model, chunks: 0, done: true, premium })}\n`,
  )
  return c.json(response as ResponsesResult)
}

const isAsyncIterable = <T>(value: unknown): value is AsyncIterable<T> =>
  Boolean(value)
  && typeof (value as AsyncIterable<T>)[Symbol.asyncIterator] === "function"

const isStreamingRequested = (payload: ResponsesPayload): boolean =>
  Boolean(payload.stream)

const useFunctionApplyPatch = (payload: ResponsesPayload): void => {
  const config = getConfig()
  const useFunctionApplyPatch = config.useFunctionApplyPatch ?? true
  if (useFunctionApplyPatch) {
    logger.debug("Using function tool apply_patch for responses")
    if (Array.isArray(payload.tools)) {
      const toolsArr = payload.tools
      for (let i = 0; i < toolsArr.length; i++) {
        const t = toolsArr[i]
        if (t.type === "custom" && t.name === "apply_patch") {
          toolsArr[i] = {
            type: "function",
            name: t.name,
            description: "Use the `apply_patch` tool to edit files",
            parameters: {
              type: "object",
              properties: {
                input: {
                  type: "string",
                  description: "The entire contents of the apply_patch command",
                },
              },
              required: ["input"],
            },
            strict: false,
          }
        }
      }
    }
  }
}

interface StreamIdTracker {
  outputItems: Map<number, string>
  contentParts: Map<string, string>
  messageItems: Map<number, string>
}

const createStreamIdTracker = (): StreamIdTracker => ({
  outputItems: new Map(),
  contentParts: new Map(),
  messageItems: new Map(),
})

interface StreamEventData {
  item?: {
    id?: string
    type?: string
    summary?: Array<unknown>
  }
  output_index?: number
  content_index?: number
  item_id?: string
  response?: {
    output?: Array<{
      type?: string
      summary?: Array<unknown>
    }>
  }
}

// AI SDK compatibility: GitHub Copilot uses different IDs for added vs done events
// We track IDs from 'added' events and reuse them in 'done' events
const fixStreamIds = (
  data: string,
  event: string | undefined,
  tracker: StreamIdTracker,
): string => {
  if (!data) return data

  try {
    const parsed = JSON.parse(data) as StreamEventData

    switch (event) {
      case "response.output_item.added": {
        return handleOutputItemAdded(parsed, tracker)
      }
      case "response.output_item.done": {
        return handleOutputItemDone(parsed, tracker)
      }
      case "response.content_part.added": {
        return handleContentPartAdded(parsed, tracker)
      }
      case "response.content_part.done": {
        return handleContentPartDone(parsed, tracker)
      }
      case "response.output_text.delta":
      case "response.output_text.done": {
        return handleOutputText(parsed, tracker)
      }
      case "response.completed":
      case "response.incomplete": {
        return handleResponseCompleted(parsed)
      }
      default: {
        return data
      }
    }
  } catch {
    return data
  }
}

const handleOutputItemAdded = (
  parsed: StreamEventData,
  tracker: StreamIdTracker,
): string => {
  if (!parsed.item?.id) return JSON.stringify(parsed)

  const outputIndex = parsed.output_index ?? 0
  tracker.outputItems.set(outputIndex, parsed.item.id)

  if (parsed.item.type === "message") {
    tracker.messageItems.set(outputIndex, parsed.item.id)
  }
  if (
    parsed.item.type === "reasoning"
    && Array.isArray(parsed.item.summary)
    && parsed.item.summary.length === 0
  ) {
    delete parsed.item.summary
  }
  return JSON.stringify(parsed)
}

const handleOutputItemDone = (
  parsed: StreamEventData,
  tracker: StreamIdTracker,
): string => {
  if (!parsed.item) return JSON.stringify(parsed)

  const outputIndex = parsed.output_index ?? 0
  const originalId = tracker.outputItems.get(outputIndex)
  if (originalId) {
    parsed.item.id = originalId
  }
  if (
    parsed.item.type === "reasoning"
    && Array.isArray(parsed.item.summary)
    && parsed.item.summary.length === 0
  ) {
    delete parsed.item.summary
  }
  return JSON.stringify(parsed)
}

const handleContentPartAdded = (
  parsed: StreamEventData,
  tracker: StreamIdTracker,
): string => {
  const outputIndex = parsed.output_index ?? 0
  const contentIndex = parsed.content_index ?? 0
  const key = `${outputIndex}:${contentIndex}`

  if (parsed.item_id) {
    tracker.contentParts.set(key, parsed.item_id)
  }

  const messageId = tracker.messageItems.get(outputIndex)
  if (messageId) {
    parsed.item_id = messageId
  }
  return JSON.stringify(parsed)
}

const handleContentPartDone = (
  parsed: StreamEventData,
  tracker: StreamIdTracker,
): string => {
  const outputIndex = parsed.output_index ?? 0
  const contentIndex = parsed.content_index ?? 0
  const key = `${outputIndex}:${contentIndex}`

  const messageId = tracker.messageItems.get(outputIndex)
  if (messageId) {
    parsed.item_id = messageId
  } else {
    const originalItemId = tracker.contentParts.get(key)
    if (originalItemId) {
      parsed.item_id = originalItemId
    }
  }

  tracker.contentParts.delete(key)
  return JSON.stringify(parsed)
}

const handleOutputText = (
  parsed: StreamEventData,
  tracker: StreamIdTracker,
): string => {
  const outputIndex = parsed.output_index ?? 0
  const messageId = tracker.messageItems.get(outputIndex)
  if (messageId) {
    parsed.item_id = messageId
  }
  return JSON.stringify(parsed)
}

const handleResponseCompleted = (parsed: StreamEventData): string => {
  if (!parsed.response?.output) return JSON.stringify(parsed)

  for (const item of parsed.response.output) {
    if (
      item.type === "reasoning"
      && Array.isArray(item.summary)
      && item.summary.length === 0
    ) {
      delete item.summary
    }
  }
  return JSON.stringify(parsed)
}
