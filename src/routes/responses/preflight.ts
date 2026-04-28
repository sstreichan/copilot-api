import type { ResponsesPayload } from "~/services/copilot/create-responses"

import { getConfig, isResponsesApiWebSearchEnabled } from "~/lib/config"
import { createHandlerLogger } from "~/lib/logger"

import {
  compactInputByLatestCompaction,
  normalizeResponsesInputForReplay,
} from "./utils"

const logger = createHandlerLogger("responses-handler")

const COPILOT_UNSUPPORTED_TOOL_TYPES = new Set(["image_generation"])

export const useFunctionApplyPatch = (payload: ResponsesPayload): void => {
  const config = getConfig()
  const useApplyPatch = config.useFunctionApplyPatch ?? true
  if (useApplyPatch) {
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
 * Runs all preflight mutations on a Responses payload in the required order:
 * 1. useFunctionApplyPatch  — rewrite apply_patch custom→function tool
 * 2. removeUnsupportedTools — drop image_generation etc.
 * 3. removeWebSearchTool    — conditional on config flag
 * 4. normalizeResponsesInputForReplay — clean up reasoning items
 * 5. compactInputByLatestCompaction  — keep only post-compaction input
 */
export const preflightResponsesPayload = (payload: ResponsesPayload): void => {
  useFunctionApplyPatch(payload)
  removeUnsupportedTools(payload)
  if (!isResponsesApiWebSearchEnabled()) {
    removeWebSearchTool(payload)
  }
  normalizeResponsesInputForReplay(payload)
  compactInputByLatestCompaction(payload)
}
