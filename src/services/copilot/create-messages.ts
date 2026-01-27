import consola from "consola"

import type { AnthropicMessagesPayload } from "~/routes/messages/anthropic-types"

import { copilotBaseUrl, copilotHeaders } from "~/lib/api-config"
import { HTTPError } from "~/lib/error"
import { state } from "~/lib/state"

export interface CreateMessagesOptions {
  initiator?: "user" | "agent"
  anthropicBeta?: string
}

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

  consola.debug("Native Messages API request:", {
    model: payload.model,
    stream: payload.stream,
  })

  const response = await fetch(`${copilotBaseUrl(state)}/v1/messages`, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  })

  if (!response.ok) {
    consola.error("Failed to create native messages", response.status)
    throw new HTTPError("Failed to create native messages", response)
  }

  // Return raw Response for passthrough (both streaming and non-streaming)
  return response
}
