import crypto from "node:crypto"

import type { State } from "./state"

export const standardHeaders = () => ({
  "content-type": "application/json",
  accept: "application/json",
})

export const copilotBaseUrl = (state: State) =>
  `https://api.${state.accountType}.githubcopilot.com`

// Assume copilotHeaders was refactored correctly in the first attempt and its structure should be preserved.
// The focus of this task is githubHeaders.
export const copilotHeaders = (
  state: State,
  openaiIntent: string,
): Record<string, string> => {
  const headers: Record<string, string> = {}
  headers["Authorization"] = `Bearer ${state.copilotToken}`
  if (openaiIntent === "conversation-panel") {
    headers["content-type"] = standardHeaders()["content-type"]
  }
  headers["copilot-integration-id"] = "vscode-chat"
  headers["editor-plugin-version"] = `copilot-chat/${state.copilotChatVersion}`
  headers["editor-version"] = `vscode/${state.vsCodeVersion}`
  headers["openai-intent"] = openaiIntent
  headers["User-Agent"] = `copilot-chat/${state.copilotChatVersion}`
  headers["vscode-machineid"] = state.machineId
  headers["vscode-sessionid"] = state.sessionId
  headers["x-github-api-version"] = `${state.apiVersion}`
  if (openaiIntent === "conversation-panel") {
    headers["x-initiator"] = "agent"
    headers["x-interaction-id"] = state.interactionId
  }
  headers["x-interaction-type"] = openaiIntent
  headers["x-request-id"] = crypto.randomUUID()
  headers["x-vscode-user-agent-library-version"] = "electron-fetch"
  headers["sec-fetch-site"] = "none"
  headers["sec-fetch-mode"] = "no-cors"
  headers["sec-fetch-dest"] = "empty"
  headers["accept-encoding"] = "gzip, deflate, br, zstd"
  headers["priority"] = "u=4, i"
  return headers
}

export const GITHUB_API_BASE_URL = "https://api.github.com"
export const githubHeaders = (
  state: State,
  target: string,
): Record<string, string> => {
  const headers: Record<string, string> = {}

  if (target === "user") {
    headers["accept"] = "application/vnd.github+json"
    headers["authorization"] = `token ${state.githubToken}`
    headers["user-agent"] = `copilot-chat/${state.copilotChatVersion}`
    headers["x-github-api-version"] = "2022-11-28"
    headers["x-vscode-user-agent-library-version"] = "electron-fetch"
    headers["sec-fetch-site"] = "none"
    headers["sec-fetch-mode"] = "no-cors"
    headers["sec-fetch-dest"] = "empty"
    headers["accept-encoding"] = "gzip, deflate, br, zstd"
    headers["priority"] = "u=4, i"
  } else if (target === "token") {
    headers["authorization"] = `token ${state.githubToken}`
    headers["editor-plugin-version"] =
      `copilot-chat/${state.copilotChatVersion}`
    headers["editor-version"] = `vscode/${state.vsCodeVersion}`
    headers["user-agent"] = `copilot-chat/${state.copilotChatVersion}`
    headers["x-github-api-version"] = "2025-04-01"
    headers["x-vscode-user-agent-library-version"] = "electron-fetch"
    headers["sec-fetch-site"] = "none"
    headers["sec-fetch-mode"] = "no-cors"
    headers["sec-fetch-dest"] = "empty"
    headers["priority"] = "u=4, i"
  }
  return headers
}

export const GITHUB_BASE_URL = "https://github.com"
export const GITHUB_CLIENT_ID = "Iv1.b507a08c87ecfe98"
export const GITHUB_APP_SCOPES = ["read:user"].join(" ")
