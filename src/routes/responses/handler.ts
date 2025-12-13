import type { Context } from "hono"

import consola from "consola"
import { streamSSE } from "hono/streaming"

import { awaitApproval } from "~/lib/approval"
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
    return `${base} [${premium.remaining} left]`
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
