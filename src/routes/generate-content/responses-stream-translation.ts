import consola from "consola"

import {
  type ResponseCompletedEvent,
  type ResponseCreatedEvent,
  type ResponseErrorEvent,
  type ResponseFailedEvent,
  type ResponseFunctionCallArgumentsDeltaEvent,
  type ResponseFunctionCallArgumentsDoneEvent,
  type ResponseIncompleteEvent,
  type ResponseOutputItemAddedEvent,
  type ResponseOutputItemDoneEvent,
  type ResponseReasoningSummaryTextDeltaEvent,
  type ResponseReasoningSummaryTextDoneEvent,
  type ResponsesResult,
  type ResponseStreamEvent,
  type ResponseTextDeltaEvent,
  type ResponseTextDoneEvent,
} from "~/services/copilot/create-responses"

import {
  type GeminiStreamResponse,
  type GeminiPart,
  type GeminiCandidate,
  type GeminiUsageMetadata,
} from "./types"

// Maximum consecutive whitespace in function call arguments before aborting
const MAX_CONSECUTIVE_FUNCTION_CALL_WHITESPACE = 20

export class FunctionCallArgumentsValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "FunctionCallArgumentsValidationError"
  }
}

// Track whitespace runs to detect malformed function call arguments
const updateWhitespaceRunState = (
  previousCount: number,
  chunk: string,
): { nextCount: number; exceeded: boolean } => {
  let count = previousCount
  for (const char of chunk) {
    if (char === " " || char === "\r" || char === "\n") {
      count += 1
      if (count > MAX_CONSECUTIVE_FUNCTION_CALL_WHITESPACE) {
        return { nextCount: count, exceeded: true }
      }
      continue
    }
    count = 0
  }
  return { nextCount: count, exceeded: false }
}

// Streaming state for Gemini response assembly
export interface GeminiResponsesStreamState {
  streamStarted: boolean
  streamCompleted: boolean
  accumulatedText: string
  currentToolCalls: Map<number, PartialToolCall>
  usageMetadata?: GeminiUsageMetadata
}

type PartialToolCall = {
  name: string
  argsAccumulator: string
  consecutiveWhitespaceCount: number
}

export const createGeminiResponsesStreamState =
  (): GeminiResponsesStreamState => ({
    streamStarted: false,
    streamCompleted: false,
    accumulatedText: "",
    currentToolCalls: new Map(),
    usageMetadata: undefined,
  })

// Main translation function: Responses stream event → Gemini stream chunk
export const translateResponsesStreamEventToGemini = (
  rawEvent: ResponseStreamEvent,
  state: GeminiResponsesStreamState,
): GeminiStreamResponse | null => {
  const eventType = rawEvent.type
  switch (eventType) {
    case "response.created": {
      return handleResponseCreated(rawEvent, state)
    }
    case "response.output_item.added": {
      return handleOutputItemAdded(rawEvent, state)
    }
    case "response.output_text.delta": {
      return handleOutputTextDelta(rawEvent, state)
    }
    case "response.output_text.done": {
      return handleOutputTextDone(rawEvent, state)
    }
    case "response.function_call_arguments.delta": {
      return handleFunctionCallArgumentsDelta(rawEvent, state)
    }
    case "response.function_call_arguments.done": {
      return handleFunctionCallArgumentsDone(rawEvent, state)
    }
    case "response.output_item.done": {
      return handleOutputItemDone(rawEvent, state)
    }
    case "response.reasoning_summary_text.delta": {
      return handleReasoningSummaryTextDelta(rawEvent, state)
    }
    case "response.reasoning_summary_text.done": {
      return handleReasoningSummaryTextDone(rawEvent, state)
    }
    case "response.completed":
    case "response.incomplete": {
      return handleResponseCompleted(rawEvent, state)
    }
    case "response.failed": {
      return handleResponseFailed(rawEvent, state)
    }
    case "error": {
      return handleErrorEvent(rawEvent, state)
    }
    default: {
      return null
    }
  }
}

// ----------------------
// Event Handlers
// ----------------------

const handleResponseCreated = (
  rawEvent: ResponseCreatedEvent,
  _state: GeminiResponsesStreamState,
): GeminiStreamResponse | null => {
  // Extract and send usage metadata in the initial chunk
  // This allows Gemini CLI to track token usage from the start
  const usageMetadata = mapResponsesUsageMetadata(rawEvent.response)

  return {
    candidates: [
      {
        content: { parts: [], role: "model" },
        index: 0,
      },
    ],
    usageMetadata,
  }
}

const handleOutputItemAdded = (
  rawEvent: ResponseOutputItemAddedEvent,
  state: GeminiResponsesStreamState,
): GeminiStreamResponse | null => {
  const item = rawEvent.item
  const outputIndex = rawEvent.output_index

  // Initialize function call tracking if item is function_call
  if (item.type === "function_call" && item.name) {
    state.currentToolCalls.set(outputIndex, {
      name: item.name,
      argsAccumulator: item.arguments || "",
      consecutiveWhitespaceCount: 0,
    })
    // Don't emit yet; wait for arguments.done
  }

  return null
}

const handleOutputTextDelta = (
  rawEvent: ResponseTextDeltaEvent,
  state: GeminiResponsesStreamState,
): GeminiStreamResponse | null => {
  const delta = rawEvent.delta
  if (!delta) return null

  state.accumulatedText += delta

  const parts: Array<GeminiPart> = [{ text: delta }]
  return {
    candidates: [
      {
        content: { parts, role: "model" },
        index: 0,
      },
    ],
  }
}

const handleOutputTextDone = (
  _rawEvent: ResponseTextDoneEvent,
  _state: GeminiResponsesStreamState,
): GeminiStreamResponse | null => {
  // Text completion marker; no action needed (accumulator already updated)
  return null
}

const handleFunctionCallArgumentsDelta = (
  rawEvent: ResponseFunctionCallArgumentsDeltaEvent,
  state: GeminiResponsesStreamState,
): GeminiStreamResponse | null => {
  const outputIndex = rawEvent.output_index
  const delta = rawEvent.delta
  if (!delta) return null

  const toolCall = state.currentToolCalls.get(outputIndex)
  if (!toolCall) {
    consola.warn(
      "[GEMINI_STREAM] Received function call arguments delta without tracked tool call",
      { outputIndex },
    )
    return null
  }

  // Check for excessive whitespace (malformed arguments detection)
  const { nextCount, exceeded } = updateWhitespaceRunState(
    toolCall.consecutiveWhitespaceCount,
    delta,
  )
  if (exceeded) {
    consola.error(
      "[GEMINI_STREAM] Function call arguments validation failed: excessive whitespace",
      { outputIndex, name: toolCall.name },
    )
    state.currentToolCalls.delete(outputIndex)
    throw new FunctionCallArgumentsValidationError(
      "Excessive whitespace in function call arguments",
    )
  }

  toolCall.consecutiveWhitespaceCount = nextCount
  toolCall.argsAccumulator += delta

  // Don't emit incremental tool call deltas; wait for done event
  return null
}

const handleFunctionCallArgumentsDone = (
  rawEvent: ResponseFunctionCallArgumentsDoneEvent,
  state: GeminiResponsesStreamState,
): GeminiStreamResponse | null => {
  const outputIndex = rawEvent.output_index
  const eventName = rawEvent.name
  const argsString = rawEvent.arguments

  // Try to get name from event first, then fall back to state
  const toolCall = state.currentToolCalls.get(outputIndex)
  const name = eventName || toolCall?.name

  if (!name) {
    consola.warn("[GEMINI_STREAM] Function call done without name", {
      outputIndex,
      hasToolCall: Boolean(toolCall),
      eventName,
    })
    // Clean up orphaned state
    if (toolCall) {
      state.currentToolCalls.delete(outputIndex)
    }
    return null
  }

  let args: Record<string, unknown> = {}
  if (argsString && argsString.trim().length > 0) {
    try {
      const parsed: unknown = JSON.parse(argsString)
      if (Array.isArray(parsed)) {
        args = { arguments: parsed }
      } else if (parsed && typeof parsed === "object") {
        args = parsed as Record<string, unknown>
      }
    } catch (error) {
      consola.warn("[GEMINI_STREAM] Failed to parse function call arguments", {
        error,
        argsString,
      })
      args = { raw_arguments: argsString }
    }
  }

  // Emit complete function call
  const parts: Array<GeminiPart> = [{ functionCall: { name, args } }]
  state.currentToolCalls.delete(outputIndex)

  consola.info("[GEMINI_STREAM] Complete tool call assembled", {
    outputIndex,
    name,
    hasArgs: Boolean(argsString),
  })

  return {
    candidates: [
      {
        content: { parts, role: "model" },
        index: 0,
      },
    ],
  }
}

const handleOutputItemDone = (
  _rawEvent: ResponseOutputItemDoneEvent,
  _state: GeminiResponsesStreamState,
): GeminiStreamResponse | null => {
  // Item completion marker; no specific action for Gemini
  return null
}

const handleReasoningSummaryTextDelta = (
  _rawEvent: ResponseReasoningSummaryTextDeltaEvent,
  _state: GeminiResponsesStreamState,
): GeminiStreamResponse | null => {
  // Phase 2.1: Ignore reasoning deltas (Gemini doesn't expose reasoning incrementally)
  return null
}

const handleReasoningSummaryTextDone = (
  _rawEvent: ResponseReasoningSummaryTextDoneEvent,
  _state: GeminiResponsesStreamState,
): GeminiStreamResponse | null => {
  // Phase 2.1: Ignore reasoning completion (not exposed in Gemini stream)
  return null
}

const handleResponseCompleted = (
  rawEvent: ResponseCompletedEvent | ResponseIncompleteEvent,
  state: GeminiResponsesStreamState,
): GeminiStreamResponse | null => {
  state.streamCompleted = true

  const response = rawEvent.response
  const finishReason = mapResponsesFinishReason(response)
  const usageMetadata = mapResponsesUsageMetadata(response)
  state.usageMetadata = usageMetadata

  // Emit final chunk with finishReason and usage
  const candidate: GeminiCandidate = {
    content: {
      parts: state.accumulatedText ? [{ text: "" }] : [],
      role: "model",
    },
    finishReason,
    index: 0,
  }

  return {
    candidates: [candidate],
    usageMetadata,
  }
}

const handleResponseFailed = (
  rawEvent: ResponseFailedEvent,
  state: GeminiResponsesStreamState,
): GeminiStreamResponse | null => {
  state.streamCompleted = true
  consola.error("[GEMINI_STREAM] Response failed", rawEvent.response.error)

  return {
    candidates: [
      {
        content: { parts: [], role: "model" },
        finishReason: "OTHER",
        index: 0,
      },
    ],
  }
}

const handleErrorEvent = (
  rawEvent: ResponseErrorEvent,
  state: GeminiResponsesStreamState,
): GeminiStreamResponse | null => {
  state.streamCompleted = true
  consola.error("[GEMINI_STREAM] Error event", {
    code: rawEvent.code,
    message: rawEvent.message,
  })

  return {
    candidates: [
      {
        content: { parts: [], role: "model" },
        finishReason: "OTHER",
        index: 0,
      },
    ],
  }
}

// ----------------------
// Mapping Helpers
// ----------------------

function mapResponsesFinishReason(
  response: ResponsesResult,
): GeminiCandidate["finishReason"] | undefined {
  if (response.status === "completed") {
    return "STOP"
  }
  if (response.status === "incomplete") {
    const reason = response.incomplete_details?.reason
    if (reason === "max_output_tokens") return "MAX_TOKENS"
    if (reason === "content_filter") return "SAFETY"
    return "OTHER"
  }
  return undefined
}

function mapResponsesUsageMetadata(
  response: ResponsesResult,
): GeminiUsageMetadata {
  const usage = response.usage
  const inputTokens = usage?.input_tokens || 0
  const cached = usage?.input_tokens_details?.cached_tokens || 0
  const outputTokens = usage?.output_tokens || 0
  return {
    promptTokenCount: inputTokens - cached,
    candidatesTokenCount: outputTokens,
    totalTokenCount: usage?.total_tokens || inputTokens + outputTokens,
  }
}
