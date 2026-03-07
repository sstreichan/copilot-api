import consola from "consola"
import { events } from "fetch-event-stream"
import { randomUUID } from "node:crypto"

import { copilotBaseUrl, copilotHeaders } from "~/lib/api-config"
import { HTTPError } from "~/lib/error"
import { resolveInitiatorWithSmartAgent } from "~/lib/smart-agent"
import { state } from "~/lib/state"
import {
  trackRequestSent,
  trackResponseSuccess,
  trackResponseError,
  scheduleFeedbackEvents,
} from "~/services/telemetry/telemetry"

/**
 * Check if error response indicates a thinking block issue that can be
 * resolved by stripping thinking/reasoning fields and retrying.
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
 * Strip reasoning fields from assistant messages to avoid signature validation errors.
 * Removes both reasoning_opaque (signature) and reasoning_text (thinking content)
 * since they are paired and Copilot may recreate thinking blocks from reasoning_text.
 */
const stripReasoningFields = (
  payload: ChatCompletionsPayload,
): ChatCompletionsPayload => ({
  ...payload,
  messages: payload.messages.map((msg) => {
    if (msg.role !== "assistant") return msg

    const { reasoning_opaque: _sig, reasoning_text: _text, ...rest } = msg
    return rest
  }),
})

/** Track telemetry for a successful non-streaming response. */
function trackNonStreamSuccess(opts: {
  result: ChatCompletionResponse
  model: string
  start: number
  requestId?: string
}): void {
  const { result, model, start, requestId } = opts
  const finishReason =
    result.choices.length > 0 ? result.choices[0].finish_reason : "stop"
  const serialized = JSON.stringify(result)
  trackResponseSuccess({
    model,
    durationMs: Date.now() - start,
    requestId,
    finishReason,
    promptTokens: result.usage?.prompt_tokens,
    completionTokens: result.usage?.completion_tokens,
    bytesReceived: serialized.length,
  })
}

/** Handle a successful Copilot response, returning stream events or parsed JSON. */
async function handleOkResponse(
  response: Response,
  payload: ChatCompletionsPayload,
  opts: { start: number; requestId?: string },
) {
  if (opts.requestId) {
    scheduleFeedbackEvents(opts.requestId)
  }
  if (payload.stream) {
    trackResponseSuccess({
      model: payload.model,
      durationMs: Date.now() - opts.start,
      requestId: opts.requestId,
      finishReason: "stream",
    })
    return events(response)
  }
  const result = (await response.json()) as ChatCompletionResponse
  trackNonStreamSuccess({
    result,
    model: payload.model,
    start: opts.start,
    requestId: opts.requestId,
  })
  return result
}

/** Retry the request with reasoning fields stripped after a thinking block error. */
async function retryWithStrippedReasoningFields(
  payload: ChatCompletionsPayload,
  headers: Record<string, string>,
  opts: { start: number; requestId?: string },
) {
  consola.warn(
    "Thinking block error detected, retrying with reasoning fields stripped",
  )
  const strippedPayload = stripReasoningFields(payload)
  const retryResponse = await fetch(
    `${copilotBaseUrl(state)}/chat/completions`,
    { method: "POST", headers, body: JSON.stringify(strippedPayload) },
  )
  if (!retryResponse.ok) {
    consola.error("Retry also failed", retryResponse.status)
    trackResponseError({
      model: payload.model,
      durationMs: Date.now() - opts.start,
      statusCode: retryResponse.status,
      requestId: opts.requestId,
    })
    throw new HTTPError(
      "Failed to create chat completions (after retry)",
      retryResponse,
    )
  }
  return handleOkResponse(retryResponse, payload, opts)
}

export const createChatCompletions = async (
  payload: ChatCompletionsPayload,
) => {
  if (!state.copilotToken) throw new Error("Copilot token not found")

  const modelCallId = randomUUID()

  const enableVision = payload.messages.some(
    (x) =>
      typeof x.content !== "string"
      && x.content?.some((x) => x.type === "image_url"),
  )

  // Agent/user check: only the last message determines initiator
  const lastMessage = payload.messages.at(-1)
  const isAgentCall =
    lastMessage !== undefined
    && ["assistant", "tool"].includes(lastMessage.role)

  // Determine X-Initiator value
  const dynamicInitiator = isAgentCall ? "agent" : "user"
  const { initiator } = await resolveInitiatorWithSmartAgent(dynamicInitiator)

  // Build headers and add X-Initiator
  const headers: Record<string, string> = {
    ...copilotHeaders(state, enableVision),
    "X-Initiator": initiator,
  }

  // Extract requestId from already-built headers (do NOT re-generate)
  const requestId = headers["x-request-id"]

  const start = Date.now()
  trackRequestSent(payload.model, state.accountType, requestId, modelCallId)

  // First attempt: passthrough unchanged
  const response = await fetch(`${copilotBaseUrl(state)}/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  })

  if (response.ok) {
    return handleOkResponse(response, payload, { start, requestId })
  }

  // On error, check if it's an invalid signature error
  const errorBody = await response
    .clone()
    .json()
    .catch(() => null)

  if (response.status === 400 && isThinkingBlockError(errorBody)) {
    return retryWithStrippedReasoningFields(payload, headers, {
      start,
      requestId,
    })
  }

  // Not a signature error, throw original error
  consola.error("Failed to create chat completions", response.status)
  trackResponseError({
    model: payload.model,
    durationMs: Date.now() - start,
    statusCode: response.status,
    requestId,
  })
  throw new HTTPError("Failed to create chat completions", response)
}

// Streaming types

export interface ChatCompletionChunk {
  id: string
  object: "chat.completion.chunk"
  created: number
  model: string
  choices: Array<Choice>
  system_fingerprint?: string
  usage?: {
    prompt_tokens: number
    completion_tokens: number
    total_tokens: number
    prompt_tokens_details?: {
      cached_tokens: number
    }
    completion_tokens_details?: {
      accepted_prediction_tokens: number
      rejected_prediction_tokens: number
    }
  }
}

export interface Delta {
  content?: string | null
  role?: "user" | "assistant" | "system" | "tool"
  tool_calls?: Array<{
    index: number
    id?: string
    type?: "function"
    function?: {
      name?: string
      arguments?: string
    }
  }>
  reasoning_text?: string | null
  reasoning_opaque?: string | null
}

export interface Choice {
  index: number
  delta: Delta
  finish_reason: "stop" | "length" | "tool_calls" | "content_filter" | null
  logprobs: object | null
}

// Non-streaming types

export interface ChatCompletionResponse {
  id: string
  object: "chat.completion"
  created: number
  model: string
  choices: Array<ChoiceNonStreaming>
  system_fingerprint?: string
  usage?: {
    prompt_tokens: number
    completion_tokens: number
    total_tokens: number
    prompt_tokens_details?: {
      cached_tokens: number
    }
  }
}

interface ResponseMessage {
  role: "assistant"
  content: string | null
  reasoning_text?: string | null
  reasoning_opaque?: string | null
  tool_calls?: Array<ToolCall>
}

interface ChoiceNonStreaming {
  index: number
  message: ResponseMessage
  logprobs: object | null
  finish_reason: "stop" | "length" | "tool_calls" | "content_filter"
}

// Payload types

export interface ChatCompletionsPayload {
  messages: Array<Message>
  model: string
  temperature?: number | null
  top_p?: number | null
  max_tokens?: number | null
  stop?: string | Array<string> | null
  n?: number | null
  stream?: boolean | null

  frequency_penalty?: number | null
  presence_penalty?: number | null
  logit_bias?: Record<string, number> | null
  logprobs?: boolean | null
  response_format?: { type: "json_object" } | null
  seed?: number | null
  tools?: Array<Tool> | null
  tool_choice?:
    | "none"
    | "auto"
    | "required"
    | { type: "function"; function: { name: string } }
    | null
  user?: string | null
  thinking_budget?: number
}

export interface Tool {
  type: "function"
  function: {
    name: string
    description?: string
    parameters: Record<string, unknown>
  }
}

export interface Message {
  role: "user" | "assistant" | "system" | "tool" | "developer"
  content: string | Array<ContentPart> | null

  name?: string
  tool_calls?: Array<ToolCall>
  tool_call_id?: string
  reasoning_text?: string | null
  reasoning_opaque?: string | null
}

export interface ToolCall {
  id: string
  type: "function"
  function: {
    name: string
    arguments: string
  }
}

export type ContentPart = TextPart | ImagePart

export interface TextPart {
  type: "text"
  text: string
}

export interface ImagePart {
  type: "image_url"
  image_url: {
    url: string
    detail?: "low" | "high" | "auto"
  }
}
