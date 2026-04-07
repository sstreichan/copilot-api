import type { Context } from "hono"

import consola from "consola"

import type { Model } from "~/services/copilot/get-models"

import { awaitApproval } from "~/lib/approval"
import {
  getSmallModel,
  isMessagesApiEnabled,
  resolveAnthropicEffortForLog,
  shouldCompactUseSmallModel,
} from "~/lib/config"
import {
  colorizeModel,
  createHandlerLogger,
  debugJson,
  shouldUseColor,
} from "~/lib/logger"
import { findEndpointModel } from "~/lib/models"
import { checkRateLimit } from "~/lib/rate-limit"
import { state } from "~/lib/state"
import { generateRequestIdFromPayload, getRootSessionId } from "~/lib/utils"

import { type AnthropicMessagesPayload } from "./anthropic-types"
import {
  handleWithChatCompletions,
  handleWithMessagesApi,
  handleWithResponsesApi,
} from "./api-flows"
import {
  isCompactRequest,
  mergeToolResultForClaude,
  stripToolReferenceTurnBoundary,
} from "./preprocess"
import { parseSubagentMarkerFromFirstUser } from "./subagent-marker"

const logger = createHandlerLogger("messages-handler")
const cm = (model: string) => (shouldUseColor() ? colorizeModel(model) : model)

export async function handleCompletion(c: Context) {
  await checkRateLimit(state)

  const anthropicPayload = await c.req.json<AnthropicMessagesPayload>()
  const originalModel = anthropicPayload.model
  debugJson(logger, "Anthropic request payload:", anthropicPayload)

  const isCompact = isCompactRequest(anthropicPayload)
  if (isCompact) {
    logger.debug("Is compact request:", isCompact)
    if (shouldCompactUseSmallModel()) {
      anthropicPayload.model = getSmallModel()
    }
  }

  const subagentMarker = parseSubagentMarkerFromFirstUser(anthropicPayload)
  if (subagentMarker) {
    debugJson(logger, "Detected Subagent marker:", subagentMarker)
  }

  const sessionId = getRootSessionId(anthropicPayload, c)
  logger.debug("Extracted session ID:", sessionId)

  const anthropicBeta = c.req.header("anthropic-beta")
  logger.debug("Anthropic Beta header:", anthropicBeta)
  const noTools = !anthropicPayload.tools || anthropicPayload.tools.length === 0
  if (anthropicBeta && noTools && !isCompact) {
    anthropicPayload.model = getSmallModel()
  }

  if (!isCompact) {
    stripToolReferenceTurnBoundary(anthropicPayload)
    mergeToolResultForClaude(anthropicPayload)
  }

  const selectedModel = findEndpointModel(anthropicPayload.model)
  anthropicPayload.model = selectedModel?.id ?? anthropicPayload.model

  const requestId = generateRequestIdFromPayload(anthropicPayload, sessionId)
  logger.debug("Generated request ID:", requestId)

  const { value: effortValue, source: effortSource } =
    resolveAnthropicEffortForLog(
      anthropicPayload.output_config?.effort,
      anthropicPayload.model,
    )
  consola.info(
    `IN ${cm(originalModel)} → ${cm(anthropicPayload.model)} [effort=${effortValue} (${effortSource})]`,
  )

  if (state.manualApprove) {
    await awaitApproval()
  }

  if (shouldUseMessagesApi(selectedModel)) {
    return await handleWithMessagesApi(c, anthropicPayload, {
      anthropicBetaHeader: anthropicBeta,
      subagentMarker,
      selectedModel,
      requestId,
      sessionId,
      isCompact,
      logger,
    })
  }

  if (shouldUseResponsesApi(selectedModel)) {
    return await handleWithResponsesApi(c, anthropicPayload, {
      subagentMarker,
      selectedModel,
      requestId,
      sessionId,
      isCompact,
      logger,
    })
  }

  return await handleWithChatCompletions(c, anthropicPayload, {
    subagentMarker,
    requestId,
    sessionId,
    isCompact,
    logger,
  })
}

const RESPONSES_ENDPOINT = "/responses"
const MESSAGES_ENDPOINT = "/v1/messages"

const shouldUseResponsesApi = (selectedModel: Model | undefined): boolean => {
  return (
    selectedModel?.supported_endpoints?.includes(RESPONSES_ENDPOINT) ?? false
  )
}

const shouldUseMessagesApi = (selectedModel: Model | undefined): boolean => {
  const useMessagesApi = isMessagesApiEnabled()
  if (!useMessagesApi) {
    return false
  }

  return (
    selectedModel?.supported_endpoints?.includes(MESSAGES_ENDPOINT) ?? false
  )
}
