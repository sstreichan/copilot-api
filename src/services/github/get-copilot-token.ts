import consola from "consola"

import { getGitHubApiBaseUrl, githubHeaders } from "~/lib/api-config"
import { HTTPError } from "~/lib/error"
import { state } from "~/lib/state"

export const getCopilotToken = async () => {
  const response = await fetch(
    `${getGitHubApiBaseUrl()}/copilot_internal/v2/token`,
    {
      headers: githubHeaders(state),
    },
  )

  if (!response.ok) {
    const body = await response.text()
    consola.error(`Copilot token request failed [${response.status}]:`, body)
    throw new HTTPError(
      "Failed to get Copilot token",
      new Response(body, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      }),
    )
  }

  return (await response.json()) as GetCopilotTokenResponse
}

// Trimmed for the sake of simplicity
export interface GetCopilotTokenResponse {
  agent_mode_auto_approval?: boolean
  annotations_enabled?: boolean
  azure_only?: boolean
  blackbird_clientside_indexing?: boolean
  chat_enabled?: boolean
  chat_jetbrains_enabled?: boolean
  code_quote_enabled?: boolean
  code_review_enabled?: boolean
  codesearch?: boolean
  copilotignore_enabled?: boolean
  expires_at: number
  refresh_in: number
  individual?: boolean
  limited_user_quotas?: unknown
  limited_user_reset_date?: string | null
  prompt_8k?: boolean
  public_suggestions?: string
  sku?: string
  snippy_load_test_enabled?: boolean
  telemetry?: string
  token: string
  tracking_id?: string
  vsc_electron_fetcher_v2?: boolean
  xcode?: boolean
  xcode_chat?: boolean
  // Per-SKU isolated endpoints returned by the token exchange. This is the
  // authoritative routing source for the issued token; `/copilot_internal/user`
  // may advertise a different segmented host (e.g. business vs enterprise).
  endpoints?: {
    api?: string
    proxy?: string
    telemetry?: string
    [key: string]: string | undefined
  }
  organization_list?: Array<string>
  enterprise_list?: Array<number>
}
