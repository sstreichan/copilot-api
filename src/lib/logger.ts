import consola, { type ConsolaInstance } from "consola"
import fs from "node:fs"
import path from "node:path"
import util from "node:util"

import { getCopilotUsage } from "~/services/github/get-copilot-usage"

import { PATHS } from "./paths"
import { registerProcessCleanup } from "./process-cleanup"
import { requestContext } from "./request-context"
import { state } from "./state"

const LOG_RETENTION_DAYS = 7
const LOG_RETENTION_MS = LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000
const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000
const LOG_DIR = path.join(PATHS.APP_DIR, "logs")
const FLUSH_INTERVAL_MS = 1000
const MAX_BUFFER_SIZE = 100

const logStreams = new Map<string, fs.WriteStream>()
const logBuffers = new Map<string, Array<string>>()

let runtimeInitialized = false
let flushInterval: ReturnType<typeof setInterval> | undefined
let cleanupInterval: ReturnType<typeof setInterval> | undefined

const ensureLogDirectory = () => {
  if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true })
  }
}

const cleanupOldLogs = () => {
  if (!fs.existsSync(LOG_DIR)) {
    return
  }

  const now = Date.now()

  for (const entry of fs.readdirSync(LOG_DIR)) {
    const filePath = path.join(LOG_DIR, entry)

    let stats: fs.Stats
    try {
      stats = fs.statSync(filePath)
    } catch {
      continue
    }

    if (!stats.isFile()) {
      continue
    }

    if (now - stats.mtimeMs > LOG_RETENTION_MS) {
      try {
        fs.rmSync(filePath)
      } catch {
        continue
      }
    }
  }
}

const formatArgs = (args: Array<unknown>) =>
  args
    .map((arg) =>
      typeof arg === "string" ? arg : (
        util.inspect(arg, { depth: null, colors: false })
      ),
    )
    .join(" ")

const sanitizeName = (name: string) => {
  const normalized = name
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/^-+|-+$/g, "")

  return normalized === "" ? "handler" : normalized
}

const maybeUnref = (timer: ReturnType<typeof setInterval>) => {
  timer.unref()
}

const flushBuffer = (filePath: string) => {
  const buffer = logBuffers.get(filePath)
  if (!buffer || buffer.length === 0) {
    return
  }

  const stream = getLogStream(filePath)
  const content = buffer.join("\n") + "\n"
  stream.write(content, (error) => {
    if (error) {
      console.warn("Failed to write handler log", error)
    }
  })

  logBuffers.set(filePath, [])
}

const flushAllBuffers = () => {
  for (const filePath of logBuffers.keys()) {
    flushBuffer(filePath)
  }
}

const cleanup = () => {
  if (flushInterval) {
    clearInterval(flushInterval)
    flushInterval = undefined
  }
  if (cleanupInterval) {
    clearInterval(cleanupInterval)
    cleanupInterval = undefined
  }

  flushAllBuffers()
  for (const stream of logStreams.values()) {
    stream.end()
  }
  logStreams.clear()
  logBuffers.clear()
}

const initializeLoggerRuntime = () => {
  if (runtimeInitialized) {
    return
  }

  runtimeInitialized = true

  ensureLogDirectory()
  cleanupOldLogs()

  flushInterval = setInterval(flushAllBuffers, FLUSH_INTERVAL_MS)
  maybeUnref(flushInterval)

  cleanupInterval = setInterval(cleanupOldLogs, CLEANUP_INTERVAL_MS)
  maybeUnref(cleanupInterval)

  registerProcessCleanup(cleanup)
}

const getLogStream = (filePath: string): fs.WriteStream => {
  initializeLoggerRuntime()

  let stream = logStreams.get(filePath)
  if (!stream || stream.destroyed) {
    stream = fs.createWriteStream(filePath, { flags: "a" })
    logStreams.set(filePath, stream)

    stream.on("error", (error: unknown) => {
      console.warn("Log stream error", error)
      logStreams.delete(filePath)
    })
  }
  return stream
}

const appendLine = (filePath: string, line: string) => {
  let buffer = logBuffers.get(filePath)
  if (!buffer) {
    buffer = []
    logBuffers.set(filePath, buffer)
  }

  buffer.push(line)

  if (buffer.length >= MAX_BUFFER_SIZE) {
    flushBuffer(filePath)
  }
}

type DebugLogger = Pick<ConsolaInstance, "debug">

export const debugLazy = (
  logger: DebugLogger,
  factory: () => [unknown, ...Array<unknown>],
): void => {
  if (!state.verbose) {
    return
  }

  logger.debug(...factory())
}

export const debugJson = (
  logger: DebugLogger,
  label: string,
  value: unknown,
): void => {
  debugLazy(logger, () => [label, JSON.stringify(value)])
}

export const debugJsonTail = (
  logger: DebugLogger,
  label: string,
  { value, tailLength = 400 }: { value: unknown; tailLength?: number },
): void => {
  debugLazy(logger, () => [label, JSON.stringify(value).slice(-tailLength)])
}

export const createHandlerLogger = (name: string): ConsolaInstance => {
  const sanitizedName = sanitizeName(name)
  const instance = consola.withTag(name)

  if (state.verbose) {
    instance.level = 5
  }
  instance.setReporters([])

  instance.addReporter({
    log(logObj) {
      initializeLoggerRuntime()

      const context = requestContext.getStore()
      const traceId = context?.traceId
      const date = logObj.date
      const dateKey = date.toLocaleDateString("sv-SE")
      const timestamp = date.toLocaleString("sv-SE", { hour12: false })
      const filePath = path.join(LOG_DIR, `${sanitizedName}-${dateKey}.log`)
      const message = formatArgs(logObj.args as Array<unknown>)
      const traceIdStr = traceId ? ` [${traceId}]` : ""
      const line = `[${timestamp}] [${logObj.type}] [${logObj.tag || name}]${traceIdStr}${
        message ? ` ${message}` : ""
      }`

      appendLine(filePath, line)
    },
  })

  return instance
}

// Stream progress logging utilities
export function shouldUseColor(): boolean {
  if (process.env.NO_COLOR !== undefined) return false
  if (!process.stdout.isTTY) return false
  return true
}

// 23 visually distinct ANSI 256 colors (prime count for better hash distribution)
const MODEL_COLOR_CODES: Array<number> = [
  196, // red
  202, // dark orange
  208, // orange
  214, // gold
  220, // bright yellow
  226, // yellow
  46, // green
  82, // bright green
  34, // forest green
  48, // sea green
  51, // cyan
  45, // turquoise
  39, // sky blue
  33, // azure
  27, // blue
  21, // deep blue
  57, // indigo
  93, // violet
  129, // bright purple
  165, // magenta
  201, // hot pink
  213, // pink
  175, // mauve
]

// FNV-1a hash — better distribution than djb2 for short strings
function fnv1a(input: string): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < input.length; i++) {
    hash ^= input.codePointAt(i) ?? 0
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash
}

export function colorizeModel(name: string): string {
  const hash = fnv1a(name)
  const colorCode = MODEL_COLOR_CODES[hash % MODEL_COLOR_CODES.length]
  return `\x1b[38;5;${colorCode}m${name}\x1b[0m`
}

export interface StreamLogOptions {
  model: string
  chunks: number
  done: boolean
  premium?: { remaining: number; total: number } | null
}

export const writeStreamLog = (
  options: StreamLogOptions,
  appendNewline = false,
): void => {
  const output = formatStreamLog(options)
  if (!output) {
    return
  }

  process.stdout.write(appendNewline ? `${output}\n` : output)
}

const premiumInfoSymbol = Symbol("premiumInfo")
const PREMIUM_QUOTA_SNAPSHOT_HEADER = "x-quota-snapshot-premium_interactions"

const formatPremiumRemaining = (value: number): string => {
  const rounded = Math.round((value + Number.EPSILON) * 100) / 100
  return rounded.toFixed(2).replace(/\.?0+$/, "")
}

export const getPremiumInfoFromHeaders = (
  headers: Headers | Record<string, string> | undefined,
): { remaining: number; total: number } | null => {
  if (!headers) return null

  const raw =
    headers instanceof Headers ?
      headers.get(PREMIUM_QUOTA_SNAPSHOT_HEADER)
    : headers[PREMIUM_QUOTA_SNAPSHOT_HEADER]

  if (!raw) return null

  const params = new URLSearchParams(raw)
  const total = Number(params.get("ent"))
  const remainingPercent = Number(params.get("rem"))

  if (
    !Number.isFinite(total)
    || !Number.isFinite(remainingPercent)
    || total < 0
  ) {
    return null
  }

  return {
    remaining: (total * remainingPercent) / 100,
    total,
  }
}

export const attachPremiumInfo = <T extends object>(
  value: T,
  premium: { remaining: number; total: number } | null,
): T => {
  Object.defineProperty(value, premiumInfoSymbol, {
    value: premium,
    enumerable: false,
    configurable: true,
  })
  return value
}

export const getAttachedPremiumInfo = (
  value: unknown,
): { remaining: number; total: number } | null => {
  if (!value || (typeof value !== "object" && typeof value !== "function")) {
    return null
  }

  return (
    (value as Record<symbol, { remaining: number; total: number } | null>)[
      premiumInfoSymbol
    ] ?? null
  )
}

export const getPremiumInfo = async (): Promise<{
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

export const resolvePremiumInfo = async (
  value: unknown,
  _context: string,
): Promise<{ remaining: number; total: number } | null> => {
  const attached = getAttachedPremiumInfo(value)
  if (attached) {
    return attached
  }

  return getPremiumInfo()
}

export const formatStreamLog = ({
  model,
  chunks,
  done,
  premium,
}: StreamLogOptions): string => {
  if (!done) {
    return ""
  }

  const displayModel = shouldUseColor() ? colorizeModel(model) : model
  const base = `\x1b[2K\r↪ ${displayModel} ${chunks} ✓`
  if (premium) {
    // Color based on remaining percentage: green > 50%, yellow 20-50%, red < 20%
    const pct = premium.remaining / premium.total
    let numColor = "\x1b[31m" // red < 20%
    if (pct > 0.5)
      numColor = "\x1b[32m" // green
    else if (pct > 0.2) numColor = "\x1b[33m" // yellow
    const reset = "\x1b[0m"
    const dim = "\x1b[2m"
    return `${base} [${numColor}${formatPremiumRemaining(premium.remaining)}${reset} ${dim}left${reset}]`
  }
  return base
}
