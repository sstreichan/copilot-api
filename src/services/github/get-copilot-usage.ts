import consola from "consola"

import { getGitHubApiBaseUrl, githubHeaders } from "~/lib/api-config"
import { HTTPError } from "~/lib/error"
import { state } from "~/lib/state"

export interface ShouldUseAgentModeParams {
  entitlement: number
  remaining: number
  dayOfMonth: number
  daysInMonth: number
}

/**
 * Determines whether to use agent mode based on quota usage progress.
 *
 * Algorithm:
 *   ideal_daily = entitlement / days_in_month
 *   expected_remaining = entitlement - (day_of_month × ideal_daily)
 *   if remaining <= expected_remaining → use agent (at or over budget)
 *
 * Uses <= to trigger at exact threshold (stops at expected, not below).
 * Math.max(5, ...) ensures minimum 5 quota reserve even at month end.
 */
export function shouldUseAgentMode(params: ShouldUseAgentModeParams): boolean {
  const { entitlement, remaining, dayOfMonth, daysInMonth } = params
  const idealDaily = entitlement / daysInMonth
  const expectedRemaining = Math.max(5, entitlement - dayOfMonth * idealDaily)
  return remaining <= expectedRemaining
}

export type SmartAgentReason = "over_budget" | "hysteresis" | "error"

export interface SmartAgentDecision {
  forceAgent: boolean
  remaining?: number
  expected?: number
  idealDaily?: number
  error?: string
  reason?: SmartAgentReason
}

/**
 * Get days in month from the current date.
 */
function getDaysInMonth(now: Date): number {
  return new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate()
}

/**
 * Fetches usage and determines whether to force agent mode.
 *
 * - forceAgent: true → over budget, force agent mode
 * - forceAgent: false → on budget, use existing logic (check tool/assistant)
 *
 * Returns forceAgent: true on API failure (protect user quota).
 */
export async function getSmartAgentDecision(
  now: Date = new Date(),
): Promise<SmartAgentDecision> {
  try {
    const usage = await getCopilotUsage()
    const quota = usage.quota_snapshots.premium_interactions
    const daysInMonth = getDaysInMonth(now)
    const dayOfMonth = now.getDate()
    const expectedRemaining = Math.max(
      5,
      quota.entitlement - dayOfMonth * (quota.entitlement / daysInMonth),
    )

    const forceAgent = shouldUseAgentMode({
      entitlement: quota.entitlement,
      remaining: quota.remaining,
      dayOfMonth,
      daysInMonth,
    })

    return {
      forceAgent,
      remaining: quota.remaining,
      expected: Math.round(expectedRemaining),
      idealDaily: quota.entitlement / daysInMonth,
      reason: forceAgent ? "over_budget" : undefined,
    }
  } catch (error) {
    consola.warn("[quota] Failed to fetch usage, defaulting to agent mode")
    return {
      forceAgent: true,
      error: error instanceof Error ? error.message : String(error),
      reason: "error" as const,
    }
  }
}

export const getCopilotUsage = async (): Promise<CopilotUsageResponse> => {
  const response = await fetch(
    `${getGitHubApiBaseUrl()}/copilot_internal/user`,
    {
      headers: githubHeaders(state),
    },
  )

  if (!response.ok) {
    throw new HTTPError("Failed to get Copilot usage", response)
  }

  return (await response.json()) as CopilotUsageResponse
}

export interface QuotaDetail {
  entitlement: number
  overage_count: number
  overage_permitted: boolean
  percent_remaining: number
  quota_id: string
  quota_remaining: number
  remaining: number
  unlimited: boolean
}

interface QuotaSnapshots {
  chat: QuotaDetail
  completions: QuotaDetail
  premium_interactions: QuotaDetail
}

interface CopilotUsageResponse {
  access_type_sku: string
  analytics_tracking_id: string
  assigned_date: string
  can_signup_for_limited: boolean
  chat_enabled: boolean
  copilot_plan: string
  organization_login_list: Array<unknown>
  organization_list: Array<unknown>
  quota_reset_date: string
  quota_snapshots: QuotaSnapshots
}
