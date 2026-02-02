import consola from "consola"
import { events } from "fetch-event-stream"

import { copilotBaseUrl, copilotHeaders } from "~/lib/api-config"
import { HTTPError } from "~/lib/error"
import { resolveInitiatorWithSmartAgent } from "~/lib/smart-agent"
import { state } from "~/lib/state"

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

export const createChatCompletions = async (
  payload: ChatCompletionsPayload,
) => {
  if (!state.copilotToken) throw new Error("Copilot token not found")

  const enableVision = payload.messages.some(
    (x) =>
      typeof x.content !== "string"
      && x.content?.some((x) => x.type === "image_url"),
  )

  // Agent/user check for X-Initiator header
  // Determine if any message is from an agent ("assistant" or "tool")
  // Refactor `isAgentCall` logic to check only the last message in the history rather than any message. This prevents valid user messages from being incorrectly flagged as agent calls due to previous assistant history, ensuring proper credit consumption for multi-turn conversations.
  let isAgentCall = false
  if (payload.messages.length > 0) {
    const lastMessage = payload.messages.at(-1)
    if (lastMessage) {
      isAgentCall = ["assistant", "tool"].includes(lastMessage.role)
    }
  }

  // Determine X-Initiator value
  const dynamicInitiator = isAgentCall ? "agent" : "user"
  const { initiator } = await resolveInitiatorWithSmartAgent(dynamicInitiator)

  // Build headers and add X-Initiator
  const headers: Record<string, string> = {
    ...copilotHeaders(state, enableVision),
    "X-Initiator": initiator,
  }

  // First attempt: passthrough unchanged
  const response = await fetch(`${copilotBaseUrl(state)}/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  })

  if (response.ok) {
    if (payload.stream) {
      return events(response)
    }
    return (await response.json()) as ChatCompletionResponse
  }

  // On error, check if it's an invalid signature error
  const errorBody = await response
    .clone()
    .json()
    .catch(() => null)

  if (response.status === 400 && isInvalidSignatureError(errorBody)) {
    consola.warn(
      "Invalid signature in thinking block detected, retrying with reasoning fields stripped",
    )

    // Retry with reasoning fields stripped
    const strippedPayload = stripReasoningFields(payload)
    const retryResponse = await fetch(
      `${copilotBaseUrl(state)}/chat/completions`,
      {
        method: "POST",
        headers,
        body: JSON.stringify(strippedPayload),
      },
    )

    if (!retryResponse.ok) {
      consola.error("Retry also failed", retryResponse.status)
      throw new HTTPError(
        "Failed to create chat completions (after retry)",
        retryResponse,
      )
    }

    if (payload.stream) {
      return events(retryResponse)
    }
    return (await retryResponse.json()) as ChatCompletionResponse
  }

  // Not a signature error, throw original error
  consola.error("Failed to create chat completions", response.status)
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
