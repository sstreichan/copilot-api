import type { ResponsesPayload } from "~/services/copilot/create-responses"

import { isResponsesApiWebSearchEnabled } from "~/lib/config"
import { createHandlerLogger } from "~/lib/logger"

import { normalizeResponsesInputForReplay } from "./utils"

const logger = createHandlerLogger("responses-handler")

const COPILOT_UNSUPPORTED_TOOL_TYPES = new Set(["image_generation"])

export const removeWebSearchTool = (payload: ResponsesPayload): void => {
  if (!Array.isArray(payload.tools) || payload.tools.length === 0) return

  payload.tools = payload.tools.filter((t) => {
    return t.type !== "web_search"
  })
}

export const removeUnsupportedTools = (payload: ResponsesPayload): void => {
  if (!Array.isArray(payload.tools) || payload.tools.length === 0) return

  const dropped: Array<string> = []
  payload.tools = payload.tools.filter((t) => {
    const type = t.type as string
    if (COPILOT_UNSUPPORTED_TOOL_TYPES.has(type)) {
      dropped.push(type)
      return false
    }
    return true
  })
  if (dropped.length > 0) {
    logger.debug("Removed unsupported tools:", dropped)
  }
}

/**
 * Runs common Responses preflight mutations in order:
 * 1. removeUnsupportedTools — drop image_generation etc.
 * 2. removeWebSearchTool — conditional on config flag
 * 3. normalizeResponsesInputForReplay — clean up reasoning items
 */
export const preflightResponsesPayload = (payload: ResponsesPayload): void => {
  removeUnsupportedTools(payload)
  if (!isResponsesApiWebSearchEnabled()) {
    removeWebSearchTool(payload)
  }
  normalizeResponsesInputForReplay(payload)
}
