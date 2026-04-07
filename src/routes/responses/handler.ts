import type { Context } from "hono"

import consola from "consola"
import { streamSSE } from "hono/streaming"

import { awaitApproval } from "~/lib/approval"
import {
  getConfig,
  isResponsesApiWebSearchEnabled,
  resolveEffortForLog,
} from "~/lib/config"
import {
  colorizeModel,
  createHandlerLogger,
  debugJson,
  debugJsonTail,
  resolvePremiumInfo,
  shouldUseColor,
  writeStreamLog,
} from "~/lib/logger"
import { checkRateLimit } from "~/lib/rate-limit"
import { state } from "~/lib/state"
import {
  generateRequestIdFromPayload,
  getRootSessionIdFromResponsesPayload,
  getStableSessionKeyFromResponsesPayload,
  getUUID,
} from "~/lib/utils"
import {
  createResponses,
  type Reasoning,
  type ResponsesPayload,
  type ResponsesResult,
} from "~/services/copilot/create-responses"

import { createStreamIdTracker, fixStreamIds } from "./stream-id-sync"
import {
  applyResponsesApiContextManagement,
  compactInputByLatestCompaction,
  getResponsesRequestOptions,
  normalizeResponsesInputForReplay,
} from "./utils"

const logger = createHandlerLogger("responses-handler")

const cm = (model: string) => (shouldUseColor() ? colorizeModel(model) : model)

const RESPONSES_ENDPOINT = "/responses"

export const handleResponses = async (c: Context) => {
  await checkRateLimit(state)

  const payload = await c.req.json<ResponsesPayload>()
  debugJson(logger, "Responses request payload:", payload)

  const stableSessionKey = getStableSessionKeyFromResponsesPayload(payload, c)
  if (!payload.prompt_cache_key?.trim() && stableSessionKey) {
    payload.prompt_cache_key = stableSessionKey
  }

  const rootSessionId = getRootSessionIdFromResponsesPayload(payload, c)
  logger.debug("Extracted root session ID:", rootSessionId)

  const requestId = generateRequestIdFromPayload(
    { messages: payload.input },
    rootSessionId,
  )
  logger.debug("Generated request ID:", requestId)

  const sessionId = rootSessionId ?? getUUID(requestId)
  logger.debug("Extracted session ID:", sessionId)

  useFunctionApplyPatch(payload)

  if (!isResponsesApiWebSearchEnabled()) {
    removeWebSearchTool(payload)
  }

  normalizeResponsesInputForReplay(payload)

  compactInputByLatestCompaction(payload)

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

  applyResponsesApiContextManagement(
    payload,
    selectedModel?.capabilities.limits.max_prompt_tokens,
  )

  debugJson(logger, "Translated Responses payload:", payload)

  const { vision, initiator } = getResponsesRequestOptions(payload)

  const effortForLog = ensureReasoningEffort(payload)

  consola.info(
    `IN ${cm(payload.model)} [effort=${effortForLog.value} (${effortForLog.source})]`,
  )

  if (state.manualApprove) {
    await awaitApproval()
  }

  const response = await createResponses(payload, {
    vision,
    initiator,
    requestId,
    sessionId: sessionId,
  })

  if (isStreamingRequested(payload) && isAsyncIterable(response)) {
    logger.debug("Forwarding native Responses stream")
    return streamSSE(c, async (stream) => {
      let chunkCount = 0
      const idTracker = createStreamIdTracker()

      try {
        for await (const chunk of response) {
          debugJson(logger, "Responses stream chunk:", chunk)
          chunkCount++
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
        writeStreamLog(
          { model: payload.model, chunks: chunkCount, done: true, premium },
          true,
        )
      }
    })
  }

  debugJsonTail(logger, "Forwarding native Responses result:", {
    value: response,
    tailLength: 400,
  })
  const premium = await resolvePremiumInfo(response, "responses/non-stream")
  writeStreamLog({ model: payload.model, chunks: 0, done: true, premium }, true)
  return c.json(response as ResponsesResult)
}

const isAsyncIterable = <T>(value: unknown): value is AsyncIterable<T> =>
  Boolean(value)
  && typeof (value as AsyncIterable<T>)[Symbol.asyncIterator] === "function"

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

const removeWebSearchTool = (payload: ResponsesPayload): void => {
  if (!Array.isArray(payload.tools) || payload.tools.length === 0) return

  payload.tools = payload.tools.filter((t) => {
    return t.type !== "web_search"
  })
}
