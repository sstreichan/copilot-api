/* eslint-disable max-lines -- Anthropic ↔ Responses translation keeps stream-state, message-state, and event-state machines colocated for atomic review */

import type {
  AnthropicAssistantContentBlock,
  AnthropicContentBlockDeltaEvent,
  AnthropicContentBlockStartEvent,
  AnthropicContentBlockStopEvent,
  AnthropicErrorEvent,
  AnthropicImageBlock,
  AnthropicMessage,
  AnthropicMessagesPayload,
  AnthropicResponse,
  AnthropicMessageDeltaEvent,
  AnthropicMessageStartEvent,
  AnthropicMessageStopEvent,
  AnthropicPingEvent,
  AnthropicStreamEventData,
  AnthropicTool,
  AnthropicToolResultContentBlock,
  AnthropicToolResultBlock,
  AnthropicUserContentBlock,
} from "~/routes/messages/anthropic-types"
import type {
  ResponseCompletedEvent,
  ResponseCreatedEvent,
  ResponseFailedEvent,
  ResponseFunctionCallArgumentsDeltaEvent,
  ResponseFunctionCallArgumentsDoneEvent,
  ResponseIncompleteEvent,
  ResponseOutputContentBlock,
  ResponseOutputFunctionCall,
  ResponseOutputItem,
  ResponseOutputMessage,
  ResponseOutputReasoning,
  ResponseOutputRefusal,
  ResponseOutputText,
  ResponseFunctionCallOutputItem,
  ResponseFunctionToolCallItem,
  ResponseInputContent,
  ResponseInputItem,
  ResponseInputMessage,
  ResponseInputReasoning,
  ResponsesResult,
  ResponsesPayload,
} from "~/services/copilot/create-responses"

const DEFAULT_MAX_TOKENS = 12800

export interface AnthropicToResponsesStreamState {
  response: ResponsesResult | null
  currentTextBlockIndex: number | null
  currentToolUseBlockIndex: number | null
  pendingStopReason: "completed" | "incomplete"
  outputItems: Array<ResponseOutputItem>
  outputText: string
  functionCalls: Map<
    number,
    {
      item: ResponseOutputFunctionCall
      argumentsDone: boolean
    }
  >
}

export const createAnthropicToResponsesStreamState =
  (): AnthropicToResponsesStreamState => ({
    response: null,
    currentTextBlockIndex: null,
    currentToolUseBlockIndex: null,
    pendingStopReason: "completed",
    outputItems: [],
    outputText: "",
    functionCalls: new Map(),
  })

export const translateResponsesToAnthropicMessages = (
  payload: ResponsesPayload,
): AnthropicMessagesPayload => {
  const result: AnthropicMessagesPayload = {
    model: payload.model,
    max_tokens: payload.max_output_tokens ?? DEFAULT_MAX_TOKENS,
    messages: translateResponsesInput(payload.input),
  }

  const system = translateInstructions(payload.instructions)
  if (system) result.system = system

  const tools = translateTools(payload.tools)
  if (tools) result.tools = tools

  const toolChoice = translateToolChoice(payload.tool_choice)
  if (toolChoice) result.tool_choice = toolChoice

  const outputConfig = translateReasoning(payload.reasoning)
  if (outputConfig) result.output_config = outputConfig

  if (payload.temperature !== null && payload.temperature !== undefined) {
    result.temperature = payload.temperature
  }
  if (payload.top_p !== null && payload.top_p !== undefined) {
    result.top_p = payload.top_p
  }
  if (payload.stream !== null && payload.stream !== undefined) {
    result.stream = payload.stream
  }
  if (payload.metadata?.user_id) {
    result.metadata = { user_id: payload.metadata.user_id }
  }

  return result
}

export const translateAnthropicMessageToResponses = (
  response: AnthropicResponse,
): ResponsesResult => {
  const { output, outputText } =
    translateAnthropicContentToResponsesOutput(response)
  const status = mapAnthropicStopReasonToResponsesStatus(response.stop_reason)

  return {
    id: response.id,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    model: response.model,
    output,
    output_text: outputText,
    status,
    usage: response.usage ? buildResponseUsage(response.usage) : null,
    error: null,
    incomplete_details: mapAnthropicStopReasonToIncompleteDetails(
      response.stop_reason,
    ),
    instructions: null,
    metadata: null,
    parallel_tool_calls: true,
    temperature: null,
    tool_choice: "auto",
    tools: [],
    top_p: null,
  }
}

export const translateAnthropicStreamEventToResponsesStreamEvents = (
  event: AnthropicStreamEventData,
  state: AnthropicToResponsesStreamState,
): Array<
  | ResponseCreatedEvent
  | ResponseFunctionCallArgumentsDeltaEvent
  | ResponseFunctionCallArgumentsDoneEvent
  | ResponseFailedEvent
  | ResponseCompletedEvent
  | ResponseIncompleteEvent
  | {
      type: "response.output_text.delta"
      sequence_number: number
      item_id: string
      output_index: number
      content_index: number
      delta: string
    }
  | {
      type: "response.output_text.done"
      sequence_number: number
      item_id: string
      output_index: number
      content_index: number
      text: string
    }
> => {
  switch (event.type) {
    case "message_start": {
      return handleAnthropicMessageStart(event, state)
    }
    case "content_block_start": {
      return handleAnthropicContentBlockStart(event, state)
    }
    case "content_block_delta": {
      return handleAnthropicContentBlockDelta(event, state)
    }
    case "content_block_stop": {
      return handleAnthropicContentBlockStop(event, state)
    }
    case "message_delta": {
      return handleAnthropicMessageDelta(event, state)
    }
    case "message_stop": {
      return handleAnthropicMessageStop(event, state)
    }
    case "ping": {
      return handleAnthropicPing(event, state)
    }
    case "error": {
      return handleAnthropicError(event, state)
    }
    default: {
      return []
    }
  }
}

const translateInstructions = (
  instructions: ResponsesPayload["instructions"],
): AnthropicMessagesPayload["system"] => {
  const trimmed = instructions?.trim()
  return trimmed || undefined
}

const translateAnthropicContentToResponsesOutput = (
  response: AnthropicResponse,
): { output: Array<ResponseOutputItem>; outputText: string } => {
  const output: Array<ResponseOutputItem> = []
  let outputText = ""
  let messageIndex = 0
  let functionIndex = 0

  for (const block of response.content) {
    switch (block.type) {
      case "text": {
        const messageOutput = createMessageOutputFromAnthropicText(
          response,
          block.text,
          messageIndex,
        )
        if (messageOutput) {
          output.push(messageOutput)
          messageIndex += 1
        }
        if (response.stop_reason !== "refusal") {
          outputText += block.text
        }
        break
      }
      case "thinking": {
        const reasoningOutput =
          createReasoningOutputFromAnthropicThinking(block)
        if (reasoningOutput) output.push(reasoningOutput)
        break
      }
      case "tool_use": {
        output.push(
          createFunctionCallOutputFromAnthropicToolUse(block, functionIndex),
        )
        functionIndex += 1
        break
      }
      default: {
        break
      }
    }
  }

  return { output, outputText }
}

const createMessageOutputFromAnthropicText = (
  response: AnthropicResponse,
  text: string,
  index: number,
): ResponseOutputMessage | undefined => {
  if (!text) return undefined

  const content: Array<ResponseOutputContentBlock> =
    response.stop_reason === "refusal" ?
      [createRefusalOutputBlock(text)]
    : [createTextOutputBlock(text)]

  return {
    id: `${response.id}_msg_${index}`,
    type: "message",
    role: "assistant",
    status: mapAnthropicStopReasonToMessageStatus(response.stop_reason),
    content,
  }
}

const createReasoningOutputFromAnthropicThinking = (
  block: Extract<AnthropicAssistantContentBlock, { type: "thinking" }>,
): ResponseOutputReasoning | undefined => {
  const { encryptedContent, id } = parseReasoningSignature(block.signature)
  if (!id) return undefined

  return {
    id,
    type: "reasoning",
    summary:
      block.thinking ? [{ type: "summary_text", text: block.thinking }] : [],
    encrypted_content: encryptedContent,
    status: "completed",
  }
}

const createFunctionCallOutputFromAnthropicToolUse = (
  block: Extract<AnthropicAssistantContentBlock, { type: "tool_use" }>,
  index: number,
): ResponseOutputFunctionCall => ({
  id: `fc_${block.id || index}`,
  type: "function_call",
  call_id: block.id,
  name: block.name,
  arguments: JSON.stringify(block.input),
  status: "completed",
})

const createTextOutputBlock = (text: string): ResponseOutputText => ({
  type: "output_text",
  text,
  annotations: [],
})

const createRefusalOutputBlock = (text: string): ResponseOutputRefusal => ({
  type: "refusal",
  refusal: text,
})

const mapAnthropicStopReasonToResponsesStatus = (
  stopReason: AnthropicResponse["stop_reason"],
): ResponsesResult["status"] => {
  if (stopReason === "max_tokens" || stopReason === "refusal") {
    return "incomplete"
  }

  return "completed"
}

const mapAnthropicStopReasonToMessageStatus = (
  stopReason: AnthropicResponse["stop_reason"],
): ResponseOutputMessage["status"] => {
  if (stopReason === "max_tokens" || stopReason === "refusal") {
    return "incomplete"
  }

  return "completed"
}

const mapAnthropicStopReasonToIncompleteDetails = (
  stopReason: AnthropicResponse["stop_reason"],
): ResponsesResult["incomplete_details"] => {
  if (stopReason === "max_tokens") {
    return { reason: "max_output_tokens" }
  }

  if (stopReason === "refusal") {
    return { reason: "content_filter" }
  }

  return null
}

const parseReasoningSignature = (
  signature: string,
): { encryptedContent: string; id: string } => {
  const splitIndex = signature.lastIndexOf("@")

  if (splitIndex <= 0 || splitIndex === signature.length - 1) {
    return { encryptedContent: signature, id: "" }
  }

  return {
    encryptedContent: signature.slice(0, splitIndex),
    id: signature.slice(splitIndex + 1),
  }
}

const translateResponsesInput = (
  input: ResponsesPayload["input"],
): Array<AnthropicMessage> => {
  if (typeof input === "string") {
    return [{ role: "user", content: input }]
  }

  if (!Array.isArray(input)) {
    return []
  }

  const messages: Array<AnthropicMessage> = []
  let pendingAssistantBlocks: Array<AnthropicAssistantContentBlock> = []

  const flushAssistantBlocks = () => {
    if (pendingAssistantBlocks.length === 0) return
    messages.push({ role: "assistant", content: pendingAssistantBlocks })
    pendingAssistantBlocks = []
  }

  for (const item of input) {
    if (isReasoningItem(item)) {
      const thinking = translateReasoningItem(item)
      if (thinking) pendingAssistantBlocks.push(thinking)
      continue
    }

    if (isFunctionCallItem(item)) {
      const toolUse = translateFunctionCall(item)
      if (toolUse) pendingAssistantBlocks.push(toolUse)
      continue
    }

    if (isFunctionCallOutputItem(item)) {
      flushAssistantBlocks()
      const toolResult = translateFunctionCallOutput(item)
      if (toolResult) {
        messages.push({ role: "user", content: [toolResult] })
      }
      continue
    }

    if (isResponseInputMessage(item)) {
      flushAssistantBlocks()
      const message = translateMessage(item)
      if (message) messages.push(message)
    }
  }

  flushAssistantBlocks()

  return messages
}

const translateMessage = (
  item: ResponseInputMessage,
): AnthropicMessage | undefined => {
  if (item.role !== "user" && item.role !== "assistant") {
    return undefined
  }

  if (typeof item.content === "string") {
    return { role: item.role, content: item.content }
  }

  if (!Array.isArray(item.content)) {
    return undefined
  }

  if (item.role === "user") {
    const content = item.content.flatMap((block) =>
      translateUserContentBlock(block),
    )
    return content.length > 0 ? { role: "user", content } : undefined
  }

  const content = item.content.flatMap((block) =>
    translateAssistantContentBlock(block),
  )
  return content.length > 0 ? { role: "assistant", content } : undefined
}

const translateUserContentBlock = (
  block: ResponseInputContent,
): Array<AnthropicUserContentBlock> => {
  const text = extractText(block)
  if (text) return [{ type: "text", text }]

  const image = translateImageBlock(block)
  return image ? [image] : []
}

const translateAssistantContentBlock = (
  block: ResponseInputContent,
): Array<AnthropicAssistantContentBlock> => {
  const text = extractText(block)
  return text ? [{ type: "text", text }] : []
}

const extractText = (block: ResponseInputContent): string | undefined => {
  if (!isRecord(block)) return undefined
  if (
    (block.type === "input_text" || block.type === "output_text")
    && typeof block.text === "string"
  ) {
    return block.text
  }
  return undefined
}

const translateImageBlock = (
  block: ResponseInputContent,
): AnthropicImageBlock | undefined => {
  if (!isRecord(block) || block.type !== "input_image") return undefined

  if (typeof block.image_url === "string") {
    return parseImageDataUrl(block.image_url)
  }

  return undefined
}

const parseImageDataUrl = (
  imageUrl: string,
): AnthropicImageBlock | undefined => {
  const match = /^data:(image\/(?:jpeg|png|gif|webp));base64,(.+)$/i.exec(
    imageUrl,
  )
  if (!match) return undefined

  const mediaType =
    match[1].toLowerCase() as AnthropicImageBlock["source"]["media_type"]
  const data = match[2]
  if (!data) return undefined

  return {
    type: "image",
    source: {
      type: "base64",
      media_type: mediaType,
      data,
    },
  }
}

const translateReasoningItem = (
  item: ResponseInputReasoning,
): AnthropicAssistantContentBlock | undefined => {
  const thinking = item.summary
    .map((summary) => summary.text)
    .join("")
    .trim()
  if (!thinking) return undefined

  return {
    type: "thinking",
    thinking,
    signature: `${item.encrypted_content ?? ""}@${item.id ?? ""}`,
  }
}

const translateFunctionCall = (
  item: ResponseFunctionToolCallItem,
): AnthropicAssistantContentBlock | undefined => {
  if (!item.call_id || !item.name) return undefined
  return {
    type: "tool_use",
    id: item.call_id,
    name: item.name,
    input: parseFunctionArguments(item.arguments),
  }
}

const translateFunctionCallOutput = (
  item: ResponseFunctionCallOutputItem,
): AnthropicToolResultBlock | undefined => {
  if (!item.call_id) return undefined
  return {
    type: "tool_result",
    tool_use_id: item.call_id,
    content: translateToolOutput(item.output),
  }
}

const translateToolOutput = (
  output: ResponseFunctionCallOutputItem["output"],
): AnthropicToolResultBlock["content"] => {
  if (typeof output === "string") return output

  const content = output.flatMap((block) =>
    translateToolResultContentBlock(block),
  )
  return content.length > 0 ? content : ""
}

const translateToolResultContentBlock = (
  block: ResponseInputContent,
): Array<AnthropicToolResultContentBlock> => {
  const text = extractText(block)
  if (text) return [{ type: "text", text }]

  const image = translateImageBlock(block)
  return image ? [image] : []
}

const translateTools = (
  tools: ResponsesPayload["tools"],
): AnthropicMessagesPayload["tools"] => {
  if (!Array.isArray(tools)) return undefined

  const translated = tools.flatMap((tool): Array<AnthropicTool> => {
    if (tool.type !== "function" || typeof tool.name !== "string") return []
    return [
      {
        name: tool.name,
        description:
          typeof tool.description === "string" ? tool.description : undefined,
        input_schema: isRecord(tool.parameters) ? tool.parameters : {},
      },
    ]
  })

  return translated.length > 0 ? translated : undefined
}

const translateToolChoice = (
  toolChoice: ResponsesPayload["tool_choice"],
): AnthropicMessagesPayload["tool_choice"] => {
  if (!toolChoice) return undefined

  if (toolChoice === "auto") return { type: "auto" }
  if (toolChoice === "required") return { type: "any" }
  if (toolChoice === "none") return { type: "none" }

  if (toolChoice.name) {
    return { type: "tool", name: toolChoice.name }
  }

  return undefined
}

const translateReasoning = (
  reasoning: ResponsesPayload["reasoning"],
): AnthropicMessagesPayload["output_config"] => {
  if (!reasoning?.effort) return undefined
  if (reasoning.effort === "none" || reasoning.effort === "minimal") {
    return undefined
  }
  return { effort: reasoning.effort }
}

const parseFunctionArguments = (
  rawArguments: string,
): Record<string, unknown> => {
  if (!rawArguments.trim()) return {}

  try {
    const parsed: unknown = JSON.parse(rawArguments)
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
    return { arguments: parsed }
  } catch {
    return { arguments: rawArguments }
  }
}

const isResponseInputMessage = (
  item: ResponseInputItem,
): item is ResponseInputMessage =>
  isRecord(item)
  && (item.type === undefined || item.type === "message")
  && typeof item.role === "string"

const isFunctionCallItem = (
  item: ResponseInputItem,
): item is ResponseFunctionToolCallItem =>
  isRecord(item)
  && item.type === "function_call"
  && typeof item.call_id === "string"
  && typeof item.name === "string"
  && typeof item.arguments === "string"

const isFunctionCallOutputItem = (
  item: ResponseInputItem,
): item is ResponseFunctionCallOutputItem =>
  isRecord(item)
  && item.type === "function_call_output"
  && typeof item.call_id === "string"

const isReasoningItem = (
  item: ResponseInputItem,
): item is ResponseInputReasoning =>
  isRecord(item) && item.type === "reasoning" && Array.isArray(item.summary)

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null

const handleAnthropicMessageStart = (
  event: AnthropicMessageStartEvent,
  state: AnthropicToResponsesStreamState,
): Array<ResponseCreatedEvent> => {
  const response: ResponsesResult = {
    id: event.message.id,
    object: "response",
    created_at: Date.now(),
    model: event.message.model,
    output: state.outputItems,
    output_text: state.outputText,
    status: "in_progress",
    usage:
      event.message.usage ? buildResponseUsage(event.message.usage) : undefined,
    error: null,
    incomplete_details: null,
    instructions: null,
    metadata: null,
    parallel_tool_calls: false,
    temperature: null,
    tool_choice: "auto",
    tools: [],
    top_p: null,
  }

  state.response = response
  return [{ type: "response.created", sequence_number: 0, response }]
}

const handleAnthropicContentBlockStart = (
  event: AnthropicContentBlockStartEvent,
  state: AnthropicToResponsesStreamState,
): Array<never> => {
  if (event.content_block.type === "text") {
    state.currentTextBlockIndex = event.index
    state.currentToolUseBlockIndex = null

    const messageItem = getOrCreateMessageOutputItem(state)
    const content = messageItem.content ?? []
    if (!content[0] || content[0].type !== "output_text") {
      content[0] = {
        type: "output_text",
        text: "",
        annotations: [],
      } satisfies ResponseOutputText
      messageItem.content = content
    }
    return []
  }

  if (event.content_block.type === "tool_use") {
    state.currentToolUseBlockIndex = event.index
    state.currentTextBlockIndex = null

    const item: ResponseOutputFunctionCall = {
      id: `fc_${event.content_block.id}`,
      type: "function_call",
      call_id: event.content_block.id,
      name: event.content_block.name,
      arguments: "",
      status: "in_progress",
    }

    state.outputItems.push(item)
    state.functionCalls.set(event.index, {
      item,
      argumentsDone: false,
    })
  }

  return []
}

const handleAnthropicContentBlockDelta = (
  event: AnthropicContentBlockDeltaEvent,
  state: AnthropicToResponsesStreamState,
): Array<
  | ResponseFunctionCallArgumentsDeltaEvent
  | {
      type: "response.output_text.delta"
      sequence_number: number
      item_id: string
      output_index: number
      content_index: number
      delta: string
    }
> => {
  if (event.delta.type === "text_delta") {
    const messageItem = getOrCreateMessageOutputItem(state)
    const outputTextBlock = getOrCreateOutputTextBlock(messageItem)
    outputTextBlock.text += event.delta.text
    state.outputText += event.delta.text

    return [
      {
        type: "response.output_text.delta",
        sequence_number: 0,
        item_id: messageItem.id,
        output_index: 0,
        content_index: 0,
        delta: event.delta.text,
      },
    ]
  }

  if (event.delta.type === "input_json_delta") {
    const functionCall = state.functionCalls.get(event.index)
    if (!functionCall) return []

    functionCall.item.arguments += event.delta.partial_json

    return [
      {
        type: "response.function_call_arguments.delta",
        sequence_number: 0,
        item_id: functionCall.item.id ?? `fc_${functionCall.item.call_id}`,
        output_index: getFunctionCallOutputIndex(state, event.index),
        delta: event.delta.partial_json,
      },
    ]
  }

  return []
}

const handleAnthropicContentBlockStop = (
  event: AnthropicContentBlockStopEvent,
  state: AnthropicToResponsesStreamState,
): Array<ResponseFunctionCallArgumentsDoneEvent> => {
  if (state.currentTextBlockIndex === event.index) {
    state.currentTextBlockIndex = null
    return []
  }

  if (state.currentToolUseBlockIndex !== event.index) {
    return []
  }

  state.currentToolUseBlockIndex = null
  const functionCall = state.functionCalls.get(event.index)
  if (!functionCall || functionCall.argumentsDone) return []

  functionCall.item.status = "completed"
  functionCall.argumentsDone = true

  return [
    {
      type: "response.function_call_arguments.done",
      sequence_number: 0,
      item_id: functionCall.item.id ?? `fc_${functionCall.item.call_id}`,
      output_index: getFunctionCallOutputIndex(state, event.index),
      name: functionCall.item.name,
      arguments: functionCall.item.arguments,
    },
  ]
}

const handleAnthropicMessageDelta = (
  event: AnthropicMessageDeltaEvent,
  state: AnthropicToResponsesStreamState,
): Array<never> => {
  if (!state.response) return []
  if (event.usage) {
    state.response.usage = buildResponseUsage(event.usage)
  }
  if (event.delta.stop_reason === "max_tokens") {
    state.pendingStopReason = "incomplete"
  }
  return []
}

const handleAnthropicMessageStop = (
  _event: AnthropicMessageStopEvent,
  state: AnthropicToResponsesStreamState,
): Array<
  | {
      type: "response.output_text.done"
      sequence_number: number
      item_id: string
      output_index: number
      content_index: number
      text: string
    }
  | ResponseCompletedEvent
  | ResponseIncompleteEvent
> => {
  if (!state.response) return []

  const events = new Array<
    | {
        type: "response.output_text.done"
        sequence_number: number
        item_id: string
        output_index: number
        content_index: number
        text: string
      }
    | ResponseCompletedEvent
    | ResponseIncompleteEvent
  >()

  const messageItem = state.outputItems.find(
    (item): item is ResponseOutputMessage => item.type === "message",
  )

  if (messageItem) {
    const outputTextBlock = getOrCreateOutputTextBlock(messageItem)
    events.push({
      type: "response.output_text.done",
      sequence_number: 0,
      item_id: messageItem.id,
      output_index: 0,
      content_index: 0,
      text: outputTextBlock.text,
    })
    messageItem.status = "completed"
  }

  state.response.output = state.outputItems
  state.response.output_text = state.outputText
  state.response.status =
    state.pendingStopReason === "incomplete" ? "incomplete" : "completed"
  state.response.incomplete_details =
    state.pendingStopReason === "incomplete" ?
      { reason: "max_output_tokens" }
    : null

  events.push({
    type:
      state.pendingStopReason === "incomplete" ?
        "response.incomplete"
      : "response.completed",
    sequence_number: 0,
    response: state.response,
  })

  return events
}

const handleAnthropicPing = (
  _event: AnthropicPingEvent,
  _state: AnthropicToResponsesStreamState,
): Array<never> => []

const handleAnthropicError = (
  event: AnthropicErrorEvent,
  state: AnthropicToResponsesStreamState,
): Array<ResponseFailedEvent> => {
  const response = ensureResponseForFailure(state)
  response.status = "failed"
  response.error = { message: event.error.message }

  return [
    {
      type: "response.failed",
      sequence_number: 0,
      response,
    },
  ]
}

const getOrCreateMessageOutputItem = (
  state: AnthropicToResponsesStreamState,
): ResponseOutputMessage => {
  const existing = state.outputItems.find(
    (item): item is ResponseOutputMessage => item.type === "message",
  )
  if (existing) return existing

  const responseId = state.response?.id ?? "resp_anthropic_stream"
  const messageItem: ResponseOutputMessage = {
    id: `${responseId}_message_0`,
    type: "message",
    role: "assistant",
    status: "in_progress",
    content: [],
  }
  state.outputItems.push(messageItem)
  return messageItem
}

const getOrCreateOutputTextBlock = (
  messageItem: ResponseOutputMessage,
): ResponseOutputText => {
  const existing = messageItem.content?.[0]
  if (isResponseOutputText(existing)) {
    return existing
  }

  const block: ResponseOutputText = {
    type: "output_text",
    text: "",
    annotations: [],
  }
  messageItem.content = [block]
  return block
}

const getFunctionCallOutputIndex = (
  state: AnthropicToResponsesStreamState,
  blockIndex: number,
): number => {
  const orderedBlockIndexes = [...state.functionCalls.keys()].sort(
    (a, b) => a - b,
  )
  const functionCallPosition = orderedBlockIndexes.indexOf(blockIndex)
  return state.outputItems.some((item) => item.type === "message") ?
      functionCallPosition + 1
    : functionCallPosition
}

const buildResponseUsage = (
  usage:
    | NonNullable<AnthropicMessageStartEvent["message"]["usage"]>
    | NonNullable<AnthropicMessageDeltaEvent["usage"]>,
): ResponsesResult["usage"] => {
  const inputTokens = usage.input_tokens ?? 0
  const outputTokens = usage.output_tokens
  const cachedTokens = usage.cache_read_input_tokens ?? 0

  return {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    total_tokens: inputTokens + outputTokens,
    input_tokens_details: {
      cached_tokens: cachedTokens,
    },
  }
}

const isResponseOutputText = (
  block: ResponseOutputContentBlock | undefined,
): block is ResponseOutputText => block?.type === "output_text"

const ensureResponseForFailure = (
  state: AnthropicToResponsesStreamState,
): ResponsesResult => {
  if (state.response) {
    return state.response
  }

  const response: ResponsesResult = {
    id: "resp_anthropic_stream_error",
    object: "response",
    created_at: Date.now(),
    model: "unknown",
    output: state.outputItems,
    output_text: state.outputText,
    status: "failed",
    usage: undefined,
    error: null,
    incomplete_details: null,
    instructions: null,
    metadata: null,
    parallel_tool_calls: false,
    temperature: null,
    tool_choice: "auto",
    tools: [],
    top_p: null,
  }
  state.response = response
  return response
}
