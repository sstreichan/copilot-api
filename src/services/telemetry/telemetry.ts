import consola from "consola"
import { arch, platform, release } from "node:os"
import { request } from "undici"

import { COPILOT_VERSION } from "~/lib/api-config"
import { getConfig } from "~/lib/config"
import { state } from "~/lib/state"

import {
  getCommonProperties,
  getDevDeviceId,
  getMachineId,
  SESSION_ID,
} from "./identity"
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
  EVENT_PANEL_REQUEST,
  EVENT_GHOST_TEXT_SHOWN,
  EVENT_REQUEST_SENT,
  EVENT_RESPONSE_ERROR,
  EVENT_RESPONSE_SUCCESS,
  MSFT_TELEMETRY_API_KEY,
  MSFT_TELEMETRY_ENDPOINT,
  type MsftTelemetryEnvelope,
  TELEMETRY_ENVELOPE_NAME,
  TELEMETRY_IKEY,
  TELEMETRY_SDK_VERSION,
  parseSku,
  parseTid,
  type TelemetryEnvelope,
} from "./types"

// Module-level cached state (internal, not exported)
let _tid: string | null = null
let _endpoint: string = DEFAULT_TELEMETRY_ENDPOINT
let _sku: string = ""

function createMsftEnvelope(
  eventName: string,
  properties: Record<string, string>,
  measurements?: Record<string, number>,
): MsftTelemetryEnvelope {
  const machineId = getMachineId()

  return {
    name: eventName,
    time: new Date(Date.now() - 10).toISOString(),
    ver: "4.0",
    iKey: `o:${MSFT_TELEMETRY_API_KEY.split("-")[0]}`,
    ext: {
      sdk: { ver: "1DS-Web-JS-4.3.10" },
      web: { consentDetails: '{"GPC_DataSharingOptIn":false}' },
    },
    data: {
      baseData: {
        name: eventName,
        properties: {
          ...properties,
          "abexp.assignmentcontext": "",
          "common.os": platform(),
          "common.nodeArch": arch(),
          "common.platformversion": release(),
          "common.telemetryclientversion": "1.5.0",
          "common.extname": "copilot-chat",
          "common.extversion": COPILOT_VERSION,
          "common.vscodemachineid": machineId,
          "common.vscodesessionid": SESSION_ID,
          "common.vscodecommithash": "",
          "common.sqmid": "",
          "common.devDeviceId": getDevDeviceId(),
          "common.vscodeversion": state.vsCodeVersion ?? "",
          "common.vscodereleasedate": "unknown",
          "common.isnewappinstall": false,
          "common.product": "desktop",
          "common.uikind": "desktop",
          "common.remotename": "none",
          version: "PostChannel=4.3.10",
          ...(_tid ? { "common.tid": _tid } : {}),
          ...(_sku ? { "common.sku": _sku } : {}),
        },
        ...(measurements ? { measurements } : {}),
      },
    },
  }
}

function createEnvelope(
  eventName: string,
  properties: Record<string, string>,
  measurements?: Record<string, number>,
): TelemetryEnvelope {
  const machineId = getMachineId()

  return {
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
          ...getCommonProperties({
            machineId,
            sessionId: SESSION_ID,
            vsCodeVersion: state.vsCodeVersion ?? "",
            sku: _sku,
            organizationList: state.organizationList,
            enterpriseList: state.enterpriseList,
          }),
          ...properties,
        },
        measurements,
      },
    },
  }
}

function sendTelemetryEnvelope(
  endpoint: string,
  eventName: string,
  envelope: TelemetryEnvelope,
): void {
  fetch(endpoint, {
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

function parseMsftAccepted(text: string | null): number | null {
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

  const accepted = (parsed as { acc?: unknown }).acc
  return typeof accepted === "number" ? accepted : null
}

async function sendMsftTelemetryEnvelope(
  eventName: string,
  envelope: MsftTelemetryEnvelope,
): Promise<void> {
  const { statusCode, body } = await request(MSFT_TELEMETRY_ENDPOINT, {
    method: "POST",
    headers: {
      "Client-Id": "NO_AUTH",
      "client-version": "1DS-Web-JS-4.3.10",
      apikey: MSFT_TELEMETRY_API_KEY,
      "upload-time": String(Date.now()),
      "time-delta-to-apply-millis": "use-collector-delta",
      "cache-control": "no-cache, no-store",
      "content-type": "application/x-json-stream",
      "User-Agent": `GitHubCopilotChat/${COPILOT_VERSION}`,
    },
    body: JSON.stringify(envelope),
    headersTimeout: 5000,
    bodyTimeout: 5000,
  })
  const text = await body.text().catch(() => null)
  const accepted = parseMsftAccepted(text)

  if (statusCode < 200 || statusCode >= 300) {
    consola.warn(
      "[telemetry] non-200 response:",
      eventName,
      `status=${statusCode}`,
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
}

/**
 * Initialize telemetry with Copilot token and optional endpoint.
 * Called from token.ts after token refresh.
 */
export function initTelemetry(copilotToken: string, endpoint?: string): void {
  _tid = parseTid(copilotToken)
  _sku = parseSku(copilotToken)
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

  sendTelemetryEnvelope(
    _endpoint,
    eventName,
    createEnvelope(eventName, properties, measurements),
  )
}

function trackMsftEvent(
  eventName: string,
  properties: Record<string, string>,
  measurements?: Record<string, number>,
): void {
  if (getConfig().telemetry !== true) {
    return
  }

  if (Math.random() > 0.3) {
    return
  }

  void sendMsftTelemetryEnvelope(
    eventName,
    createMsftEnvelope(eventName, properties, measurements),
  ).catch((err: unknown) => {
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

/** Options for tracking a panel.request event. */
export interface TrackPanelRequestOptions {
  command?: string
  contextTypes?: string
  promptTypes?: string
  responseType?: string
  languageId?: string
  apiType?: string
  headerRequestId?: string
  modelCallId?: string
}

/** Send panel.request event (fire-and-forget). */
export function trackPanelRequest(opts: TrackPanelRequestOptions): void {
  trackMsftEvent(
    EVENT_PANEL_REQUEST,
    {
      command: opts.command ?? "",
      contextTypes: opts.contextTypes ?? "",
      promptTypes: opts.promptTypes ?? "",
      responseType: opts.responseType ?? "",
      languageId: opts.languageId ?? "",
      apiType: opts.apiType ?? "chat_completions",
      headerRequestId: opts.headerRequestId ?? "",
      ...(opts.modelCallId !== undefined ?
        { modelCallId: opts.modelCallId }
      : {}),
    },
    {
      current_time: Math.floor(Date.now() / 1000),
    },
  )
}

/** Options for tracking a ghostText.shown event. */
export interface TrackGhostTextShownOptions {
  headerRequestId?: string
  copilot_trackingId?: string
  clientCompletionId?: string
  reason?: string
  choiceIndex?: number
  sku?: string
  timeSinceIssuedMs?: number
  timeSinceDisplayedMs?: number
  currentTime?: number
}

/** Send ghostText.shown event (fire-and-forget). */
export function trackGhostTextShown(opts: TrackGhostTextShownOptions): void {
  trackEvent(
    EVENT_GHOST_TEXT_SHOWN,
    {
      headerRequestId: opts.headerRequestId ?? "",
      copilot_trackingId: opts.copilot_trackingId ?? "",
      clientCompletionId: opts.clientCompletionId ?? "",
      reason: opts.reason ?? "",
      choiceIndex:
        opts.choiceIndex !== undefined ? String(opts.choiceIndex) : "",
      ...(opts.sku !== undefined ? { sku: opts.sku } : {}),
    },
    {
      timeSinceIssuedMs: opts.timeSinceIssuedMs ?? 0,
      timeSinceDisplayedMs: opts.timeSinceDisplayedMs ?? 0,
      current_time: opts.currentTime ?? Math.floor(Date.now() / 1000),
    },
  )
}
