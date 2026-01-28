import consola from "consola"

import type {
  AnthropicAssistantMessage,
  AnthropicMessagesPayload,
} from "~/routes/messages/anthropic-types"

import { copilotBaseUrl, copilotHeaders } from "~/lib/api-config"
import { HTTPError } from "~/lib/error"
import { state } from "~/lib/state"

export interface CreateMessagesOptions {
  initiator?: "user" | "agent"
  anthropicBeta?: string
}

/**
 * Check if error response indicates invalid signature in thinking block.
 * Example: { error: { message: "messages.1.content.0: Invalid signature in thinking block" } }
 */
const isInvalidSignatureError = (errorBody: unknown): boolean => {
  if (typeof errorBody !== "object" || errorBody === null) return false
  const err = errorBody as { error?: { message?: string } }
  const msg = err.error?.message ?? ""
  return (
    msg.includes("Invalid signature in thinking block")
    || msg.includes("Invalid `signature` in `thinking` block")
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

  const headers: Record<string, string> = {
    ...copilotHeaders(state, enableVision),
    "X-Initiator": state.forceAgent ? "agent" : (options.initiator ?? "user"),
  }

  // Forward anthropic-beta header if provided
  if (options.anthropicBeta) {
    headers["anthropic-beta"] = options.anthropicBeta
  }

  // Force temperature=1 for deep thinking (like Anthropic's extended thinking mode)
  // Note: Anthropic API doesn't allow both temperature and top_p, so we remove top_p
  // top_k can be used with temperature, so we keep it if provided
  const { top_p: _ignoredTopP, ...restPayload } = payload
  const enhancedPayload = {
    ...restPayload,
    temperature: 1,
  }

  consola.debug("Native Messages API request:", {
    model: payload.model,
    stream: payload.stream,
  })

  // First attempt: passthrough unchanged
  const response = await fetch(`${copilotBaseUrl(state)}/v1/messages`, {
    method: "POST",
    headers,
    body: JSON.stringify(enhancedPayload),
  })

  if (response.ok) {
    return response
  }

  // On error, check if it's an invalid signature error
  // Clone response so we can read body and still throw original error if needed
  const errorBody = await response
    .clone()
    .json()
    .catch(() => null)

  if (response.status === 400 && isInvalidSignatureError(errorBody)) {
    consola.warn(
      "Invalid signature in thinking block detected, retrying with thinking blocks stripped",
    )

    // Retry with thinking blocks stripped
    const strippedPayload = stripThinkingBlocks(enhancedPayload)
    const retryResponse = await fetch(`${copilotBaseUrl(state)}/v1/messages`, {
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

  // Not a signature error, throw original error
  consola.error("Failed to create native messages", response.status)
  throw new HTTPError("Failed to create native messages", response)
}
