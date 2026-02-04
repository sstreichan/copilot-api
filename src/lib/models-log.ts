import type { Model } from "~/services/copilot/get-models"

const ANSI_BOLD_YELLOW = "\x1b[1;33m"
const ANSI_RESET = "\x1b[0m"

type FormatModelsLogOptions = {
  color?: boolean
}

function shouldUseColor(explicit?: boolean): boolean {
  if (explicit !== undefined) return explicit
  if (process.env.NO_COLOR !== undefined) return false
  return process.stdout.isTTY
}

function formatPremiumMark(isPremium: boolean, useColor: boolean): string {
  if (!isPremium) return ""
  if (!useColor) return "★"
  return `${ANSI_BOLD_YELLOW}★${ANSI_RESET}`
}

function formatTokenCount(tokens?: number): string {
  if (!tokens) return "-"
  if (tokens >= 1_000_000) {
    const millions = tokens / 1_000_000
    const fixed = millions.toFixed(1)
    const compact = fixed.endsWith(".0") ? `${Math.round(millions)}` : fixed
    return `${compact}M`
  }
  return `${Math.round(tokens / 1000)}K`
}

function getContextWindow(m: Model): number {
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- runtime data may lack capabilities/limits
  return m.capabilities?.limits?.max_context_window_tokens ?? 0
}

function getMaxOutputTokens(m: Model): number {
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- runtime data may lack capabilities/limits
  return m.capabilities?.limits?.max_output_tokens ?? 0
}

function getMaxPromptTokens(m: Model): number {
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- runtime data may lack capabilities/limits
  const explicit = m.capabilities?.limits?.max_prompt_tokens
  if (typeof explicit === "number") return explicit

  const ctx = getContextWindow(m)
  const out = getMaxOutputTokens(m)
  if (ctx > 0 && out > 0) return Math.max(0, ctx - out)
  return 0
}

export function formatModelsLog(
  models: Array<Model>,
  options?: FormatModelsLogOptions,
): string {
  const useColor = shouldUseColor(options?.color)

  const grouped = Object.groupBy(models, (m) => m.vendor)
  const vendors = Object.keys(grouped).sort()

  const lines: Array<string> = [`Available models (${models.length}):\n`]

  for (const vendor of vendors) {
    const vendorModels = grouped[vendor]
    if (!vendorModels) continue

    const sorted = vendorModels.slice().sort((a, b) => {
      const byPrompt = getMaxPromptTokens(b) - getMaxPromptTokens(a)
      if (byPrompt !== 0) return byPrompt
      return getContextWindow(b) - getContextWindow(a)
    })

    lines.push(`${vendor} (${sorted.length})`)

    for (const m of sorted) {
      const ctx = formatTokenCount(getContextWindow(m))
      const prompt = formatTokenCount(getMaxPromptTokens(m))
      const output = formatTokenCount(getMaxOutputTokens(m))
      const premium = formatPremiumMark(
        m.billing?.is_premium === true,
        useColor,
      )
      const preview = m.preview ? "~" : ""

      lines.push(`  ${m.id} i${prompt}/o${output}/c${ctx}${premium}${preview}`)
    }
    lines.push("")
  }

  return lines.join("\n")
}
