import consola from "consola"

import { copilotBaseUrl, copilotModelsHeaders } from "~/lib/api-config"
import { HTTPError } from "~/lib/error"
import { state } from "~/lib/state"

export interface ModelsSessionResponse {
  available_models: Array<string>
  expires_at: number
  session_token: string
  discounted_costs?: Record<string, number>
}

export const getModelsSession = async (): Promise<ModelsSessionResponse> => {
  const headers = {
    ...copilotModelsHeaders(state),
    // copilotModelsHeaders 会删除 content-type，POST JSON 需手动补回
    "content-type": "application/json",
  }

  const response = await fetch(`${copilotBaseUrl(state)}/models/session`, {
    method: "POST",
    headers,
    body: JSON.stringify({ auto_mode: { model_hints: ["auto"] } }),
  })

  if (!response.ok) {
    const errorText = await response.clone().text()
    consola.error("Failed to get models session response body", errorText)
    throw new HTTPError("Failed to get models session", response)
  }

  return (await response.json()) as ModelsSessionResponse
}
