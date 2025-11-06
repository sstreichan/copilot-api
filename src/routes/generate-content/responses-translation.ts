import consola from "consola"

import { getExtraPromptForModel } from "~/lib/config"
import { generateToolCallId } from "~/lib/tool-call-utils"
import {
  type ResponsesPayload,
  type ResponseInputContent,
  type ResponseInputImage,
  type ResponseInputItem,
  type ResponseInputMessage,
  type ResponseInputText,
  type ResponsesResult,
  type ResponseOutputContentBlock,
  type ResponseOutputRefusal,
  type ResponseOutputText,
  type ResponseFunctionToolCallItem,
  type ResponseFunctionCallOutputItem,
  type Tool,
  type ToolChoiceFunction,
  type ToolChoiceOptions,
} from "~/services/copilot/create-responses"

import {
  type GeminiRequest,
  type GeminiResponse,
  type GeminiContent,
  type GeminiPart,
  type GeminiTextPart,
  type GeminiFunctionCallPart,
  type GeminiFunctionResponsePart,
  type GeminiTool,
  type GeminiCandidate,
  type GeminiUsageMetadata,
} from "./types"

const MESSAGE_TYPE = "message"

// ----------------------
// Request Translation (Gemini -> Responses API)
// ----------------------
export function translateGeminiToResponses(
  payload: GeminiRequest,
  model: string,
): ResponsesPayload {
  const input: Array<ResponseInputItem> = []
  const functionCallIds = new Map<string, string>()
  const functionCallCounts = new Map<string, number>() // Track call counts per function name

  for (const content of payload.contents) {
    input.push(
      ...translateGeminiContent(content, functionCallIds, functionCallCounts),
    )
  }

  const translatedTools = convertGeminiTools(payload.tools)
  const toolChoice = convertGeminiToolChoice(payload.toolConfig)

  const responsesPayload: ResponsesPayload = {
    model,
    input,
    instructions: translateSystemInstruction(payload.systemInstruction, model),
    temperature: extractTemperature(payload.generationConfig),
    top_p: null, // Gemini generationConfig does not expose top_p consistently
    max_output_tokens: extractMaxOutputTokens(payload.generationConfig),
    tools: translatedTools,
    tool_choice: toolChoice,
    metadata: null,
    safety_identifier: null,
    prompt_cache_key: null,
    stream: null, // caller sets
    store: false,
    parallel_tool_calls: true,
    // reasoning and include removed: not used in current response translation
  }

  return responsesPayload
}

// Translate a single Gemini content block to ResponseInputItems
function translateGeminiContent(
  content: GeminiContent,
  functionCallIds: Map<string, string>,
  functionCallCounts: Map<string, number>,
): Array<ResponseInputItem> {
  const items: Array<ResponseInputItem> = []
  const pendingContent: Array<ResponseInputContent> = []

  const role = content.role === "model" ? "assistant" : "user"

  for (const part of content.parts) {
    // Function call (assistant initiating tool use)
    if (isFunctionCallPart(part) && role === "assistant") {
      flushPendingContent(role, pendingContent, items)
      const callId = generateToolCallId(part.functionCall.name)

      // Use name + index as key to avoid overwriting same-name calls
      const functionName = part.functionCall.name
      const currentCount = (functionCallCounts.get(functionName) || 0) + 1
      functionCallCounts.set(functionName, currentCount)
      const uniqueKey = `${functionName}_${currentCount}`

      functionCallIds.set(uniqueKey, callId)
      items.push(createFunctionToolCall(part.functionCall.name, callId, part))
      continue
    }

    // Function response (user returning tool output)
    if (isFunctionResponsePart(part) && role === "user") {
      flushPendingContent(role, pendingContent, items)
      const name = part.functionResponse.name

      // Find the most recent call ID for this function name
      let mappedCallId: string | undefined
      const currentCount = functionCallCounts.get(name) || 0
      if (currentCount > 0) {
        const uniqueKey = `${name}_${currentCount}`
        mappedCallId = functionCallIds.get(uniqueKey)
        // Remove the mapping after use to ensure FIFO matching
        functionCallIds.delete(uniqueKey)
        // Decrement count for next response
        functionCallCounts.set(name, currentCount - 1)
      }

      const callId = mappedCallId || generateToolCallId(name)
      items.push(
        createFunctionCallOutput(callId, part.functionResponse.response),
      )
      continue
    }

    // Text part
    if (isTextPart(part)) {
      pendingContent.push(
        role === "assistant" ?
          createOutputTextContent(part.text)
        : createInputTextContent(part.text),
      )
      continue
    }

    // Inline data (treat only user images; ignore assistant images for now)
    if (isInlineDataPart(part) && role === "user") {
      pendingContent.push(createInputImageContent(part))
      continue
    }
  }

  flushPendingContent(role, pendingContent, items)
  return items
}

// ----------------------
// Helper creators (Request side)
// ----------------------
const flushPendingContent = (
  role: ResponseInputMessage["role"],
  pendingContent: Array<ResponseInputContent>,
  target: Array<ResponseInputItem>,
) => {
  if (pendingContent.length === 0) return
  const messageContent = [...pendingContent]
  target.push(createMessage(role, messageContent))
  pendingContent.length = 0
}

const createMessage = (
  role: ResponseInputMessage["role"],
  content: string | Array<ResponseInputContent>,
): ResponseInputMessage => ({
  type: MESSAGE_TYPE,
  role,
  content,
})

const createInputTextContent = (text: string): ResponseInputText => ({
  type: "input_text",
  text,
})

const createOutputTextContent = (text: string): ResponseInputText => ({
  type: "output_text",
  text,
})

const createInputImageContent = (part: {
  inlineData: { mimeType: string; data: string }
}): ResponseInputImage => ({
  type: "input_image",
  image_url: `data:${part.inlineData.mimeType};base64,${part.inlineData.data}`,
  detail: "auto",
})

const createFunctionToolCall = (
  name: string,
  callId: string,
  part: GeminiFunctionCallPart,
): ResponseFunctionToolCallItem => ({
  type: "function_call",
  call_id: callId,
  name,
  arguments: JSON.stringify(part.functionCall.args),
  status: "completed", // Non-stream Phase 1: emit completed directly
})

const createFunctionCallOutput = (
  callId: string,
  response: Record<string, unknown>,
): ResponseFunctionCallOutputItem => ({
  type: "function_call_output",
  call_id: callId,
  output: JSON.stringify(response),
  status: "completed",
})

// ----------------------
// System instruction & tools
// ----------------------
const translateSystemInstruction = (
  systemInstruction: GeminiContent | undefined,
  model: string,
): string | null => {
  const extraPrompt = getExtraPromptForModel(model)
  const MARKER = "<!-- CODEX_EXTRA_PROMPT_INJECTED -->"

  if (!systemInstruction) {
    // If no system instruction but we have extra prompt for this model, return it with marker
    return extraPrompt ? `${extraPrompt}\n${MARKER}` : null
  }

  const text = systemInstruction.parts
    .filter((p): p is GeminiTextPart => "text" in p)
    .map((p) => p.text)
    .join("\n\n")

  if (!text) {
    // If system instruction exists but has no text, return extra prompt if available
    return extraPrompt ? `${extraPrompt}\n${MARKER}` : null
  }

  if (!extraPrompt) return text

  if (text.includes(MARKER)) return text
  return `${text}\n\n${extraPrompt}\n${MARKER}`
}

const extractMaxOutputTokens = (
  generationConfig: GeminiRequest["generationConfig"] | undefined,
): number => {
  const raw =
    generationConfig
    && (generationConfig as { maxOutputTokens?: unknown }).maxOutputTokens
  const value = typeof raw === "number" ? raw : Number(raw)

  // Default to 4096 if not specified or invalid
  // No forced minimum - respect user's value or use safe default
  if (!value || Number.isNaN(value)) return 4096
  return value
}
const extractTemperature = (
  generationConfig: GeminiRequest["generationConfig"] | undefined,
): number => {
  const raw =
    generationConfig
    && (generationConfig as { temperature?: unknown }).temperature
  const value = typeof raw === "number" ? raw : Number(raw)

  // Use user-provided temperature if valid, otherwise default to 1
  if (value && !Number.isNaN(value) && value >= 0 && value <= 2) {
    return value
  }

  // Default temperature for reasoning/codex models
  return 1
}

const convertGeminiTools = (
  tools: Array<GeminiTool> | undefined,
): Array<Tool> | null => {
  if (!tools || tools.length === 0) return null

  const result: Array<Tool> = []
  for (const tool of tools) {
    // Function declarations
    if (tool.functionDeclarations) {
      for (const func of tool.functionDeclarations) {
        if (!func.name || typeof func.name !== "string" || !func.name.trim()) {
          continue
        }
        const parameters = func.parametersJsonSchema
          || func.parameters || {
            type: "object",
            properties: {},
          }
        result.push({
          type: "function",
          name: func.name,
          parameters,
          strict: false,
          ...(func.description ? { description: func.description } : {}),
        })
      }
    }

    // Special googleSearch tool mapping (mirror ChatCompletions path)
    if (tool.googleSearch !== undefined) {
      result.push({
        type: "function",
        name: "google_web_search",
        description:
          "Performs a web search using Google Search (via the Gemini API) and returns the results.",
        parameters: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description: "The search query to find information on the web.",
            },
          },
          required: ["query"],
        },
        strict: false,
      })
    }

    // urlContext not supported by Copilot Responses API → skip
  }
  return result.length > 0 ? result : null
}

const convertGeminiToolChoice = (
  toolConfig: GeminiRequest["toolConfig"] | undefined,
): ToolChoiceOptions | ToolChoiceFunction => {
  if (!toolConfig) return "auto"
  const mode = toolConfig.functionCallingConfig.mode
  switch (mode) {
    case "AUTO": {
      // If a single allowed function name is specified, prefer explicit selection
      const names = toolConfig.functionCallingConfig.allowedFunctionNames
      if (names && names.length === 1) {
        return { type: "function", name: names[0] }
      }
      return "auto"
    }
    case "ANY": {
      return "required"
    }
    case "NONE": {
      return "none"
    }
    default: {
      return "auto"
    }
  }
}

// ----------------------
// Response Translation (Responses Result -> Gemini)
// ----------------------
export function translateResponsesResultToGemini(
  response: ResponsesResult,
): GeminiResponse {
  const parts: Array<GeminiPart> = []

  // Prefer structured output items; fallback to output_text
  for (const item of response.output) {
    switch (item.type) {
      case "message": {
        const text = combineMessageTextContent(item.content)
        if (text.length > 0) {
          parts.push({ text })
        }
        break
      }
      case "function_call": {
        if (item.name) {
          parts.push({
            functionCall: {
              name: item.name,
              args: parseFunctionCallArguments(item.arguments),
            },
          })
        }
        break
      }
      // Ignore function_call_output and reasoning for minimal Phase 1 implementation
      default: {
        break
      }
    }
  }

  if (parts.length === 0 && typeof response.output_text === "string") {
    parts.push({ text: response.output_text })
  }

  const candidate: GeminiCandidate = {
    content: { parts, role: "model" },
    finishReason: mapResponsesFinishReason(response),
    index: 0,
  }

  return {
    candidates: [candidate],
    usageMetadata: mapResponsesUsageMetadata(response),
  }
}

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

// Combine text blocks inside a message output item
function combineMessageTextContent(
  content: Array<ResponseOutputContentBlock> | undefined,
): string {
  if (!Array.isArray(content)) return ""
  let aggregated = ""
  for (const block of content) {
    if (isResponseOutputText(block)) {
      aggregated += block.text
      continue
    }
    if (isResponseOutputRefusal(block)) {
      aggregated += block.refusal
      continue
    }
    if (typeof (block as { text?: unknown }).text === "string") {
      aggregated += (block as { text: string }).text
      continue
    }
    if (typeof (block as { reasoning?: unknown }).reasoning === "string") {
      aggregated += (block as { reasoning: string }).reasoning
      continue
    }
  }
  return aggregated
}

function parseFunctionCallArguments(
  rawArguments: string,
): Record<string, unknown> {
  if (typeof rawArguments !== "string" || rawArguments.trim().length === 0) {
    return {}
  }
  try {
    const parsed: unknown = JSON.parse(rawArguments)
    if (Array.isArray(parsed)) return { arguments: parsed }
    if (parsed && typeof parsed === "object") {
      return parsed as Record<string, unknown>
    }
  } catch (error) {
    consola.warn("Failed to parse function call arguments", {
      error,
      rawArguments,
    })
  }
  return { raw_arguments: rawArguments }
}

// ----------------------
// Type Guards
// ----------------------
const isTextPart = (part: GeminiPart): part is GeminiTextPart => "text" in part
const isFunctionCallPart = (part: GeminiPart): part is GeminiFunctionCallPart =>
  "functionCall" in part
const isFunctionResponsePart = (
  part: GeminiPart,
): part is GeminiFunctionResponsePart => "functionResponse" in part
const isInlineDataPart = (
  part: GeminiPart,
): part is { inlineData: { mimeType: string; data: string } } =>
  "inlineData" in part

// ----------------------
// Response Output Type Guards (reuse from Anthropic style)
// ----------------------
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null

const isResponseOutputText = (
  block: ResponseOutputContentBlock,
): block is ResponseOutputText =>
  isRecord(block)
  && "type" in block
  && (block as { type?: unknown }).type === "output_text"

const isResponseOutputRefusal = (
  block: ResponseOutputContentBlock,
): block is ResponseOutputRefusal =>
  isRecord(block)
  && "type" in block
  && (block as { type?: unknown }).type === "refusal"
