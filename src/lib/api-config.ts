import { randomUUID } from "node:crypto"

import type { State } from "./state"

export const standardHeaders = () => ({
  "content-type": "application/json",
  accept: "application/json",
})

const COPILOT_VERSION = "0.37.6"
const EDITOR_PLUGIN_VERSION = `copilot-chat/${COPILOT_VERSION}`
const USER_AGENT = `GitHubCopilotChat/${COPILOT_VERSION}`

const API_VERSION = "2025-10-01"

export const copilotBaseUrl = (state: State) =>
  state.accountType === "individual" ?
    "https://api.githubcopilot.com"
  : `https://api.${state.accountType}.githubcopilot.com`
export const copilotHeaders = (
  state: State,
  vision: boolean = false,
  intent: string = "conversation-agent",
) => {
  const requestId = randomUUID()
  const headers: Record<string, string> = {
    Authorization: `Bearer ${state.copilotToken}`,
    "content-type": standardHeaders()["content-type"],
    "copilot-integration-id": "vscode-chat",
    "editor-version": `vscode/${state.vsCodeVersion}`,
    "editor-plugin-version": EDITOR_PLUGIN_VERSION,
    "user-agent": USER_AGENT,
    "openai-intent": intent,
    "x-github-api-version": API_VERSION,
    "x-request-id": requestId,
    "x-vscode-user-agent-library-version": "electron-fetch",
    "X-Interaction-Id": state.interactionId,
    "X-Agent-Task-Id": requestId,
    "X-Interaction-Type": intent,
  }

  if (vision) headers["copilot-vision-request"] = "true"

  return headers
}

export const GITHUB_API_BASE_URL = "https://api.github.com"
export const githubHeaders = (state: State) => ({
  ...standardHeaders(),
  authorization: `token ${state.githubToken}`,
  "editor-version": `vscode/${state.vsCodeVersion}`,
  "editor-plugin-version": EDITOR_PLUGIN_VERSION,
  "user-agent": USER_AGENT,
  "x-github-api-version": API_VERSION,
  "x-vscode-user-agent-library-version": "electron-fetch",
})

export const GITHUB_BASE_URL = "https://github.com"
export const GITHUB_CLIENT_ID = "Iv1.b507a08c87ecfe98"
export const GITHUB_APP_SCOPES = ["read:user"].join(" ")
