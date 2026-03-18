// Round robin
// telemetry

const LANGUAGE_IDS = [
  "typescript",
  "python",
  "javascript",
  "go",
  "rust",
  "java",
  "cpp",
  "markdown",
  "json",
  "yaml",
]
const PARTICIPANTS = [
  "workspace",
  "default",
  "terminal",
  "notebook",
  "search",
  "testing",
  "debug",
  "scm",
]
const COMMANDS = [
  "apply",
  "fix",
  "explain",
  "refactor",
  "test",
  "doc",
  "review",
  "optimize",
]
const UI_KINDS = ["panel", "inline", "terminal", "notebook"]

export function nextLanguageId(): string {
  return LANGUAGE_IDS[Math.floor(Math.random() * LANGUAGE_IDS.length)]
}

export function nextParticipant(): string {
  return PARTICIPANTS[Math.floor(Math.random() * PARTICIPANTS.length)]
}

export function nextCommand(): string {
  return COMMANDS[Math.floor(Math.random() * COMMANDS.length)]
}

export function nextUiKind(): string {
  return UI_KINDS[Math.floor(Math.random() * UI_KINDS.length)]
}

export function randomLineStats(): {
  lineCount: number
  linesAdded: number
  linesRemoved: number
} {
  const lineCount = Math.floor(Math.random() * 196) + 5 // 5-200
  const linesAdded = Math.floor(Math.random() * lineCount)
  const linesRemoved = Math.floor(Math.random() * (lineCount - linesAdded))
  return { lineCount, linesAdded, linesRemoved }
}

export function randomFeedbackDelay(): number {
  return Math.floor(Math.random() * 13001) + 2000 // 2000-15000ms
}

/** UUID v4 for conversationId fields (e.g. inline.request / inline.done conversationId) */
export function randomConversationId(): string {
  return crypto.randomUUID()
}

/** UUID v4 for messageId fields (e.g. conversation.appliedCodeblock messageId) */
export function randomMessageId(): string {
  return crypto.randomUUID()
}

/** UUID v4 for turnId / responseId fields (e.g. response.cancelled responseId) */
export function randomTurnId(): string {
  return crypto.randomUUID()
}

/** Code block stats for panel/conversation code-block events.
 *  characterCount: 50-500 (payload: panel.action.copy shows 128 chars / 8 lines)
 *  lineCount: 1-30
 */
export function randomCodeBlockStats(): {
  characterCount: number
  lineCount: number
} {
  const lineCount = Math.floor(Math.random() * 30) + 1 // 1-30
  const characterCount = Math.floor(Math.random() * 451) + 50 // 50-500
  return { characterCount, lineCount }
}

/** Inline edit diff stats for inline.done events.
 *  charCountDiff: 0-200 (payload: inline.request markdownCharCount ~42)
 *  lineCountDiff: 0-20 (payload: inline.done editLineCount ~2)
 *  editCount: 1-5 (payload: inline.done editCount ~1)
 */
export function randomInlineStats(): {
  charCountDiff: number
  lineCountDiff: number
  editCount: number
} {
  const editCount = Math.floor(Math.random() * 5) + 1 // 1-5
  const lineCountDiff = Math.floor(Math.random() * 21) // 0-20
  const charCountDiff = Math.floor(Math.random() * 201) // 0-200
  return { charCountDiff, lineCountDiff, editCount }
}

/** General response timing in milliseconds.
 *  Range: 100-5000ms (plan spec; inline.request shows timeToComplete: 120ms typical)
 */
export function randomTimingMs(): number {
  return Math.floor(Math.random() * 4901) + 100 // 100-5000ms
}
