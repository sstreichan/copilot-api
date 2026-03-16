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
