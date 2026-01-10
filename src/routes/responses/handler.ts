import type { Context } from "hono"

import consola from "consola"
import { streamSSE } from "hono/streaming"

import { awaitApproval } from "~/lib/approval"
import { getConfig } from "~/lib/config"
import { createHandlerLogger } from "~/lib/logger"
import { checkRateLimit } from "~/lib/rate-limit"
import { state } from "~/lib/state"
import {
  createResponses,
  type ResponsesPayload,
  type ResponsesResult,
} from "~/services/copilot/create-responses"
import { getCopilotUsage } from "~/services/github/get-copilot-usage"

import { getResponsesRequestOptions } from "./utils"

const logger = createHandlerLogger("responses-handler")

const RESPONSES_ENDPOINT = "/responses"

interface OutLogOptions {
  model: string
  chunks: number
  done: boolean
  premium?: { remaining: number; total: number } | null
}

const formatOutLog = ({
  model,
  chunks,
  done,
  premium,
}: OutLogOptions): string => {
  const base = `\x1b[2K\r↪ ${model} ${chunks}${done ? " ✓" : ""}`
  if (done && premium) {
    // Color based on remaining percentage: green > 50%, yellow 20-50%, red < 20%
    const pct = premium.remaining / premium.total
    let numColor = "\x1b[31m" // red < 20%
    if (pct > 0.5)
      numColor = "\x1b[32m" // green
    else if (pct > 0.2) numColor = "\x1b[33m" // yellow
    const reset = "\x1b[0m"
    const dim = "\x1b[2m"
    return `${base} [${numColor}${premium.remaining}${reset} ${dim}left${reset}]`
  }
  return base
}

const getPremiumInfo = async (): Promise<{
  remaining: number
  total: number
} | null> => {
  try {
    const usage = await getCopilotUsage()
    const pi = usage.quota_snapshots.premium_interactions
    if (!pi.unlimited) {
      return { remaining: pi.remaining, total: pi.entitlement }
    }
  } catch {
    // Ignore errors, don't affect main flow
  }
  return null
}

export const handleResponses = async (c: Context) => {
  await checkRateLimit(state)

  const payload = await c.req.json<ResponsesPayload>()
  logger.debug("Responses request payload:", JSON.stringify(payload))

  useFunctionApplyPatch(payload)

  const selectedModel = state.models?.data.find(
    (model) => model.id === payload.model,
  )
  const supportsResponses =
    selectedModel?.supported_endpoints?.includes(RESPONSES_ENDPOINT) ?? false

  if (!supportsResponses) {
    return c.json(
      {
        error: {
          message:
            "This model does not support the responses endpoint. Please choose a different model.",
          type: "invalid_request_error",
        },
      },
      400,
    )
  }

  const { vision, initiator } = getResponsesRequestOptions(payload)

  consola.info(`IN ${payload.model}`)

  if (state.manualApprove) {
    await awaitApproval()
  }

  const response = await createResponses(payload, { vision, initiator })

  if (isStreamingRequested(payload) && isAsyncIterable(response)) {
    logger.debug("Forwarding native Responses stream")
    return streamSSE(c, async (stream) => {
      let chunkCount = 0
      try {
        for await (const chunk of response) {
          logger.debug("Responses stream chunk:", JSON.stringify(chunk))
          chunkCount++
          process.stdout.write(
            formatOutLog({
              model: payload.model,
              chunks: chunkCount,
              done: false,
            }),
          )
          await stream.writeSSE({
            id: (chunk as { id?: string }).id,
            event: (chunk as { event?: string }).event,
            data: (chunk as { data?: string }).data ?? "",
          })
        }
      } finally {
        const premium = await getPremiumInfo()
        process.stdout.write(
          `${formatOutLog({ model: payload.model, chunks: chunkCount, done: true, premium })}\n`,
        )
      }
    })
  }

  logger.debug(
    "Forwarding native Responses result:",
    JSON.stringify(response).slice(-400),
  )
  const premium = await getPremiumInfo()
  process.stdout.write(
    `${formatOutLog({ model: payload.model, chunks: 0, done: true, premium })}\n`,
  )
  return c.json(response as ResponsesResult)
}

const isAsyncIterable = <T>(value: unknown): value is AsyncIterable<T> =>
  Boolean(value)
  && typeof (value as AsyncIterable<T>)[Symbol.asyncIterator] === "function"

const isStreamingRequested = (payload: ResponsesPayload): boolean =>
  Boolean(payload.stream)

const useFunctionApplyPatch = (payload: ResponsesPayload): void => {
  const config = getConfig()
  const useFunctionApplyPatch = config.useFunctionApplyPatch ?? true
  if (useFunctionApplyPatch) {
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
