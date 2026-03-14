import consola from "consola"

import { getConfig } from "~/lib/config"
import { state } from "~/lib/state"

import { getCommonProperties, getMachineId, SESSION_ID } from "./identity"
import {
  nextUiKind,
  nextLanguageId,
  nextParticipant,
  nextCommand,
  randomLineStats,
  randomFeedbackDelay,
} from "./mock-values"
import {
  DEFAULT_TELEMETRY_ENDPOINT,
  EVENT_AUTH_NEW_TOKEN,
  EVENT_EDIT_FEEDBACK,
  EVENT_EDIT_HUNK_ACTION,
  EVENT_REQUEST_SENT,
  EVENT_RESPONSE_ERROR,
  EVENT_RESPONSE_SUCCESS,
  TELEMETRY_ENVELOPE_NAME,
  TELEMETRY_IKEY,
  TELEMETRY_SDK_VERSION,
  parseTid,
  type TelemetryEnvelope,
} from "./types"

// Module-level cached state (internal, not exported)
let _tid: string | null = null
let _endpoint: string = DEFAULT_TELEMETRY_ENDPOINT

function parseItemsAccepted(text: string | null): number | null {
  if (!text) {
    return null
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }

  if (typeof parsed !== "object" || parsed === null) {
    return null
  }

  const accepted = (parsed as { itemsAccepted?: unknown }).itemsAccepted
  return typeof accepted === "number" ? accepted : null
}

/**
 * Initialize telemetry with Copilot token and optional endpoint.
 * Called from token.ts after token refresh.
 */
export function initTelemetry(copilotToken: string, endpoint?: string): void {
  _tid = parseTid(copilotToken)
  const base = endpoint ?? DEFAULT_TELEMETRY_ENDPOINT
  _endpoint = base.endsWith("/telemetry") ? base : `${base}/telemetry`
}

/**
 * Send a telemetry event (fire-and-forget).
 * No-op if config.telemetry !== true (default: disabled).
 */
export function trackEvent(
  eventName: string,
  properties: Record<string, string>,
  measurements?: Record<string, number>,
): void {
  if (getConfig().telemetry !== true) {
    return
  }

  // Sample at 30% to reduce telemetry volume
  if (Math.random() > 0.3) {
    return
  }

  const machineId = getMachineId()
  const envelope: TelemetryEnvelope = {
    ver: 1,
    name: TELEMETRY_ENVELOPE_NAME,
    time: new Date().toISOString(),
    iKey: TELEMETRY_IKEY,
    sampleRate: 100,
    tags: {
      "ai.user.id": _tid ?? "",
      "ai.session.id": SESSION_ID,
      "ai.internal.sdkVersion": TELEMETRY_SDK_VERSION,
      "ai.cloud.roleInstance": "REDACTED",
    },
    data: {
      baseType: "EventData",
      baseData: {
        ver: 2,
        name: eventName,
        properties: {
          ...getCommonProperties(
            machineId,
            SESSION_ID,
            state.vsCodeVersion ?? "",
          ),
          ...properties,
        },
        measurements,
      },
    },
  }

  // Fire-and-forget: never await, never throw
  fetch(_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify([envelope]),
    signal: AbortSignal.timeout(5000),
  })
    .then(async (res) => {
      const text = await res.text().catch(() => null)
      const accepted = parseItemsAccepted(text)

      if (!res.ok) {
        consola.warn(
          "[telemetry] non-200 response:",
          eventName,
          `status=${res.status}`,
        )
        return
      }
      if (accepted === null) {
        consola.warn(
          "[telemetry] missing itemsAccepted:",
          eventName,
          `body=${text}`,
        )
      } else if (accepted <= 0) {
        consola.warn("[telemetry] rejected:", eventName, `accepted=${accepted}`)
      }
    })
    .catch((err: unknown) => {
      consola.warn(
        "[telemetry] send failed",
        err instanceof Error ? err.message : String(err),
      )
    })
}

// --- Convenience wrappers ---

// eslint-disable-next-line max-params
export function trackRequestSent(
  model: string,
  accountType: string,
  requestId?: string,
  modelCallId?: string,
): void {
  trackEvent(
    EVENT_REQUEST_SENT,
    {
      model,
      accountType,
      endpoint: "completions",
      engineName: "chat",
      uiKind: nextUiKind(),
      transport: "http",
      headerRequestId: requestId ?? "",
      "request.option.model": `"${model}"`,
      ...(modelCallId !== undefined ? { modelCallId } : {}),
    },
    { maxTokenWindow: 128000 },
  )
}

/** Options for tracking a successful response. Callers provide real values. */
export interface TrackResponseSuccessOptions {
  model: string
  durationMs: number
  requestId?: string
  modelCallId?: string
  finishReason?: string
  promptTokens?: number
  completionTokens?: number
  timeToFirstToken?: number
  bytesReceived?: number
}

export function trackResponseSuccess(opts: TrackResponseSuccessOptions): void {
  trackEvent(
    EVENT_RESPONSE_SUCCESS,
    {
      model: opts.model,
      modelInvoked: opts.model,
      reason: opts.finishReason ?? "stop",
      source: "panel",
      initiatorType: "user",
      apiType: "chat_completions",
      requestId: opts.requestId ?? "",
      transport: "http",
      ...(opts.modelCallId !== undefined ?
        { modelCallId: opts.modelCallId }
      : {}),
    },
    {
      totalTokenMax: 128000,
      tokenCountMax: 8192,
      promptTokenCount: opts.promptTokens ?? 0,
      completionTokens: opts.completionTokens ?? 0,
      timeToFirstToken: opts.timeToFirstToken ?? opts.durationMs,
      timeToComplete: opts.durationMs,
      bytesReceived: opts.bytesReceived ?? 0,
    },
  )
}

/** Options for tracking an error response. */
export interface TrackResponseErrorOptions {
  model: string
  durationMs: number
  statusCode: number
  requestId?: string
  modelCallId?: string
}

export function trackResponseError(opts: TrackResponseErrorOptions): void {
  trackEvent(
    EVENT_RESPONSE_ERROR,
    {
      model: opts.model,
      modelInvoked: opts.model,
      reason: "error",
      source: "panel",
      initiatorType: "user",
      apiType: "chat_completions",
      requestId: opts.requestId ?? "",
      transport: "http",
      ...(opts.modelCallId !== undefined ?
        { modelCallId: opts.modelCallId }
      : {}),
    },
    {
      duration_ms: opts.durationMs,
      status_code: opts.statusCode,
      timeToComplete: opts.durationMs,
    },
  )
}

export function trackAuthNewToken(): void {
  trackEvent(EVENT_AUTH_NEW_TOKEN, {})
}

/** Send panel.edit.feedback event (simulates user accepting/rejecting an edit). */
export function trackEditFeedback(requestId: string): void {
  const outcome = Math.random() < 0.55 ? "accepted" : "rejected"
  trackEvent(
    EVENT_EDIT_FEEDBACK,
    {
      languageId: nextLanguageId(),
      requestId,
      participant: nextParticipant(),
      command: nextCommand(),
      outcome,
      hasRemainingEdits: "false",
    },
    {
      isNotebook: 0,
      isNotebookCell: 0,
    },
  )
}

/** Send edit.hunk.action event (simulates accepting/rejecting a code hunk). */
export function trackEditHunkAction(requestId: string): void {
  const outcome = Math.random() < 0.55 ? "accepted" : "rejected"
  const stats = randomLineStats()
  trackEvent(
    EVENT_EDIT_HUNK_ACTION,
    {
      requestId,
      languageId: nextLanguageId(),
      outcome,
    },
    {
      hasRemainingEdits: 0,
      isNotebook: 0,
      isNotebookCell: 0,
      lineCount: stats.lineCount,
      linesAdded: stats.linesAdded,
      linesRemoved: stats.linesRemoved,
    },
  )
}

/**
 * Schedule delayed feedback events after a successful response.
 * Each event is independently sampled at 30% by trackEvent.
 * Fire-and-forget: no await, no error propagation.
 */
export function scheduleFeedbackEvents(requestId: string): void {
  if (!requestId) return
  // Sampling handled by trackEvent — no additional gate here
  const delayMs = randomFeedbackDelay()
  setTimeout(() => {
    trackEditFeedback(requestId)
    trackEditHunkAction(requestId)
  }, delayMs)
}
