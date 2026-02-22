import consola from "consola"

import type {
  AnthropicAssistantMessage,
  AnthropicMessagesPayload,
} from "~/routes/messages/anthropic-types"

import { copilotBaseUrl, copilotHeaders } from "~/lib/api-config"
import { getReasoningEffortForModel } from "~/lib/config"
import { HTTPError } from "~/lib/error"
import { resolveInitiatorWithSmartAgent } from "~/lib/smart-agent"
import { state } from "~/lib/state"

export interface CreateMessagesOptions {
  initiator?: "user" | "agent"
  anthropicBeta?: string
}

/**
 * Check if error response indicates a thinking block issue that can be
 * resolved by stripping thinking blocks and retrying.
 * Matches: invalid signature errors AND "thinking blocks cannot be modified" errors.
 */
const isThinkingBlockError = (errorBody: unknown): boolean => {
  if (typeof errorBody !== "object" || errorBody === null) return false
  const err = errorBody as { error?: { message?: string } }
  const msg = err.error?.message ?? ""
  return (
    msg.includes("Invalid signature in thinking block")
    || msg.includes("Invalid `signature` in `thinking` block")
    || msg.includes("cannot be modified")
  )
}

/**
 * Strip thinking blocks from assistant messages to avoid signature validation errors.
 * Only modifies assistant messages that have array content.
 */
const stripThinkingBlocks = (
  payload: AnthropicMessagesPayload,
): AnthropicMessagesPayload => ({
  ...payload,
  messages: payload.messages.map((msg) => {
    if (msg.role !== "assistant") return msg
    if (typeof msg.content === "string") return msg
    if (!Array.isArray(msg.content)) return msg
    return {
      ...msg,
      content: msg.content.filter((block) => block.type !== "thinking"),
    } as AnthropicAssistantMessage
  }),
})

/**
 * Check if payload contains image content (for Copilot-Vision-Request header).
 * Checks both direct image blocks and images inside tool_result blocks.
 */
const hasImageContent = (payload: AnthropicMessagesPayload): boolean =>
  payload.messages.some((msg) => {
    // Only user messages can contain image content
    if (msg.role !== "user") return false
    if (typeof msg.content === "string") return false
    if (!Array.isArray(msg.content)) return false
    return msg.content.some((block) => {
      if (block.type === "image") return true
      if (
        block.type === "tool_result"
        && Array.isArray(block.content)
        && block.content.some((b) => b.type === "image")
      ) {
        return true
      }
      return false
    })
  })

/**
 * Map config reasoning effort to Anthropic adaptive thinking effort level.
 */
const getAnthropicEffortForModel = (
  model: string,
): "low" | "medium" | "high" | "max" => {
  const reasoningEffort = getReasoningEffortForModel(model)

  if (reasoningEffort === "xhigh") return "max"
  if (reasoningEffort === "none" || reasoningEffort === "minimal") return "low"

  return reasoningEffort
}

/**
 * Resolve the anthropic-beta header value based on options and model capabilities.
 */
const resolveAnthropicBetaHeader = (
  options: CreateMessagesOptions,
  supportsAdaptive: boolean,
  payload: AnthropicMessagesPayload,
): string | undefined => {
  if (options.anthropicBeta) {
    // align with vscode copilot extension anthropic-beta
    const filteredBeta = options.anthropicBeta
      .split(",")
      .map((item) => item.trim())
      .filter((item) => item !== "claude-code-20250219")
      .join(",")
    return filteredBeta || undefined
  }

  if (!supportsAdaptive && payload.thinking?.budget_tokens) {
    return "interleaved-thinking-2025-05-14"
  }

  return undefined
}

/**
 * Reorder assistant message content blocks so text comes before tool_use.
 * Vertex AI rejects requests where text blocks follow tool_use blocks
 * in assistant messages, reporting "tool_use without tool_result".
 *
 * CRITICAL: thinking/redacted_thinking blocks must NOT be moved.
 * Vertex AI validates that thinking blocks remain in their original
 * positions — reordering them triggers:
 *   "thinking or redacted_thinking blocks in the latest assistant
 *    message cannot be modified"
 */
const reorderAssistantBlocks = (payload: AnthropicMessagesPayload): void => {
  for (const msg of payload.messages) {
    if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue
    // Separate thinking blocks (preserve positions) from reorderable blocks
    const entries = msg.content.map((block, index) => ({
      index,
      isThinking:
        block.type === "thinking" || block.type === "redacted_thinking",
      block,
    }))

    const thinkingEntries = entries.filter((e) => e.isThinking)
    const reorderable = entries.filter((e) => !e.isThinking)

    // Sort only non-thinking blocks: text before tool_use
    reorderable.sort((a, b) => {
      const order: Record<string, number> = { text: 0, tool_use: 1 }
      return (order[a.block.type] ?? 0) - (order[b.block.type] ?? 0)
    })

    // Reconstruct: thinking blocks at original indices, sorted non-thinking fill remaining slots
    const thinkingIndexSet = new Set(thinkingEntries.map((e) => e.index))
    let ri = 0
    const result = msg.content.map((_, i) =>
      thinkingIndexSet.has(i) ? entries[i].block : reorderable[ri++].block,
    )

    msg.content = result
  }
}

/**
 * Build the enhanced payload: strip top_p, force temperature=1,
 * and add adaptive thinking config for capable models.
 */
const buildEnhancedPayload = (
  payload: AnthropicMessagesPayload,
  supportsAdaptive: boolean,
) => {
  const { top_p: _ignoredTopP, ...restPayload } = payload

  return {
    ...restPayload,
    temperature: 1,
    ...(supportsAdaptive && {
      thinking: { type: "adaptive" as const },
      output_config: { effort: getAnthropicEffortForModel(payload.model) },
    }),
  }
}

/**
 * Send request to native /v1/messages and handle thinking block error retry.
 */
const sendWithSignatureRetry = async (
  url: string,
  headers: Record<string, string>,
  enhancedPayload: ReturnType<typeof buildEnhancedPayload>,
): Promise<Response> => {
  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(enhancedPayload),
  })

  if (response.ok) return response

  const errorBody = await response
    .clone()
    .json()
    .catch(() => null)

  if (response.status === 400 && isThinkingBlockError(errorBody)) {
    consola.warn(
      "Thinking block error detected, retrying with thinking blocks stripped",
    )
    const strippedPayload = stripThinkingBlocks(enhancedPayload)
    const retryResponse = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(strippedPayload),
    })
    if (!retryResponse.ok) {
      consola.error("Retry also failed", retryResponse.status)
      throw new HTTPError(
        "Failed to create native messages (after retry)",
        retryResponse,
      )
    }
    return retryResponse
  }

  consola.error("Failed to create native messages", response.status)
  throw new HTTPError("Failed to create native messages", response)
}

/**
 * Passthrough to Copilot's native /v1/messages endpoint.
 * No payload transformation - direct Anthropic format.
 *
 * Implements Strategy C (error fallback): if signature validation fails,
 * retry with thinking blocks stripped. This preserves request body integrity
 * unless absolutely necessary.
 */
export const createMessages = async (
  payload: AnthropicMessagesPayload,
  options: CreateMessagesOptions = {},
): Promise<Response> => {
  if (!state.copilotToken) throw new Error("Copilot token not found")

  const enableVision = hasImageContent(payload)

  // Determine X-Initiator value
  const defaultInitiator = options.initiator ?? "user"
  const { initiator } = await resolveInitiatorWithSmartAgent(defaultInitiator)

  const headers: Record<string, string> = {
    ...copilotHeaders(state, enableVision),
    "X-Initiator": initiator,
  }

  // Resolve model capabilities and build enhanced payload
  const selectedModel = state.models?.data.find((m) => m.id === payload.model)
  const supportsAdaptive =
    selectedModel?.capabilities.supports.adaptive_thinking ?? false

  const betaHeader = resolveAnthropicBetaHeader(
    options,
    supportsAdaptive,
    payload,
  )
  if (betaHeader) {
    headers["anthropic-beta"] = betaHeader
  }

  // Reorder assistant blocks: Vertex AI requires tool_use at end
  reorderAssistantBlocks(payload)

  const enhancedPayload = buildEnhancedPayload(payload, supportsAdaptive)

  if (supportsAdaptive) {
    consola.debug(
      `Adaptive thinking enabled for ${payload.model}, effort: ${getAnthropicEffortForModel(payload.model)}`,
    )
  }

  consola.debug("Native Messages API request:", {
    model: payload.model,
    stream: payload.stream,
  })

  return sendWithSignatureRetry(
    `${copilotBaseUrl(state)}/v1/messages`,
    headers,
    enhancedPayload,
  )
}
