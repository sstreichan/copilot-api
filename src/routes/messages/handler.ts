import type { Context } from "hono"

import consola from "consola"

import type { Model } from "~/services/copilot/get-models"

import { awaitApproval } from "~/lib/approval"
import {
  getSmallModel,
  isMessagesApiEnabled,
  resolveAnthropicEffortForLog,
  resolveMappedModel,
  shouldCompactUseSmallModel,
} from "~/lib/config"
import {
  colorizeModel,
  createHandlerLogger,
  debugJson,
  shouldUseColor,
} from "~/lib/logger"
import { findEndpointModel } from "~/lib/models"
import { parseProviderModelAlias } from "~/lib/provider-model"
import { checkRateLimit } from "~/lib/rate-limit"
import { state } from "~/lib/state"
import { generateRequestIdFromPayload, getRootSessionId } from "~/lib/utils"
import { handleProviderMessagesForProvider } from "~/routes/provider/messages/handler"
import { getResponsesTransportForModel } from "~/routes/responses/utils"

import type { AnthropicMessagesPayload } from "./anthropic-types"
import {
  handleWithChatCompletions,
  handleWithMessagesApi,
  handleWithResponsesApi,
} from "./api-flows"
import {
  applyLastMessageCacheControl,
  getCompactType,
  getLastMessageContentCacheControl,
  mergeToolResultForClaude,
  normalizeSystemMessages,
  sanitizeIdeTools,
  stripToolReferenceTurnBoundary,
} from "./preprocess"
import { parseSubagentMarkerFromFirstUser } from "./subagent-marker"

const logger = createHandlerLogger("messages-handler")
const cm = (model: string) => (shouldUseColor() ? colorizeModel(model) : model)

export const messagesFlowHandlers = {
  handleWithChatCompletions,
  handleWithMessagesApi,
  handleWithResponsesApi,
}

export async function handleCompletion(c: Context) {
  const anthropicPayload = await c.req.json<AnthropicMessagesPayload>()
  const requestedModel = anthropicPayload.model
  anthropicPayload.model = resolveMappedModel(anthropicPayload.model)
  if (anthropicPayload.model !== requestedModel) {
    logger.debug(
      `Resolved model mapping: ${requestedModel} -> ${anthropicPayload.model}`,
    )
  }

  const providerModelAlias = parseProviderModelAlias(anthropicPayload.model)
  if (providerModelAlias) {
    anthropicPayload.model = providerModelAlias.model
    return await handleProviderMessagesForProvider(c, {
      payload: anthropicPayload,
      provider: providerModelAlias.provider,
    })
  }

  debugJson(logger, "Anthropic request payload:", anthropicPayload)

  normalizeSystemMessages(anthropicPayload)

  await checkRateLimit(state)

  const originalModel = anthropicPayload.model

  const compactType = getCompactType(anthropicPayload)
  if (compactType !== 0) {
    logger.debug("Compact request type:", compactType)
    if (shouldCompactUseSmallModel()) {
      anthropicPayload.model = getSmallModel()
    }
  }
  sanitizeIdeTools(anthropicPayload)

  const subagentMarker = parseSubagentMarkerFromFirstUser(anthropicPayload)
  if (subagentMarker) {
    debugJson(logger, "Detected Subagent marker:", subagentMarker)
  }

  const sessionId = getRootSessionId(anthropicPayload, c)
  logger.debug("Extracted session ID:", sessionId)

  const anthropicBeta = c.req.header("anthropic-beta")
  logger.debug("Anthropic Beta header:", anthropicBeta)
  const noTools = !anthropicPayload.tools || anthropicPayload.tools.length === 0
  if (anthropicBeta && noTools && compactType === 0) {
    anthropicPayload.model = getSmallModel()
  }

  if (compactType === 0) {
    const lastMessageCacheControl = getLastMessageContentCacheControl(
      anthropicPayload.messages.at(-1),
    )
    stripToolReferenceTurnBoundary(anthropicPayload)
    mergeToolResultForClaude(anthropicPayload)
    applyLastMessageCacheControl(anthropicPayload, lastMessageCacheControl)
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
    return await messagesFlowHandlers.handleWithMessagesApi(
      c,
      anthropicPayload,
      {
        anthropicBetaHeader: anthropicBeta,
        subagentMarker,
        selectedModel,
        requestId,
        requestSessionAffinity: c.req.header("x-session-affinity"),
        requestTraceId: c.req.header("x-trace-id"),
        sessionId,
        compactType,
        logger,
      },
    )
  }

  if (shouldUseResponsesApi(selectedModel, compactType)) {
    return await messagesFlowHandlers.handleWithResponsesApi(
      c,
      anthropicPayload,
      {
        subagentMarker,
        selectedModel,
        requestId,
        requestSessionAffinity: c.req.header("x-session-affinity"),
        requestTraceId: c.req.header("x-trace-id"),
        sessionId,
        compactType,
        logger,
      },
    )
  }

  return await messagesFlowHandlers.handleWithChatCompletions(
    c,
    anthropicPayload,
    {
      subagentMarker,
      requestId,
      requestSessionAffinity: c.req.header("x-session-affinity"),
      requestTraceId: c.req.header("x-trace-id"),
      sessionId,
      compactType,
      logger,
    },
  )
}

const MESSAGES_ENDPOINT = "/v1/messages"

const shouldUseResponsesApi = (
  selectedModel: Model | undefined,
  compactType: ReturnType<typeof getCompactType>,
): boolean => {
  return Boolean(getResponsesTransportForModel(selectedModel, { compactType }))
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
