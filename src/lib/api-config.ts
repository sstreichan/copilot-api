import crypto from "node:crypto"

import type { State } from "./state"

export const standardHeaders = () => ({
  "content-type": "application/json",
  accept: "application/json",
})

export const copilotBaseUrl = (state: State) =>
  `https://api.${state.accountType}.githubcopilot.com`
export const copilotHeaders = (state: State) => ({
  Authorization: `Bearer ${state.copilotToken}`,
  "content-type": standardHeaders()["content-type"],
  "copilot-integration-id": "vscode-chat",
  "editor-version": `vscode/${state.vsCodeVersion}`,
  "editor-plugin-version": `copilot-chat/${state.copilotChatVersion}`,
  "openai-intent": "conversation-panel",
  "User-Agent": `copilot-chat/${state.copilotChatVersion}`,
  "x-github-api-version": "2025-04-01",
  "x-initiator": "agent",
  "x-interaction-id": state.interactionId,
  "x-request-id": crypto.randomUUID(),
  "x-vscode-user-agent-library-version": "electron-fetch",
})

export const GITHUB_API_BASE_URL = "https://api.github.com"
export const githubHeaders = (state: State) => ({
  ...standardHeaders(),
  authorization: `token ${state.githubToken}`,
  "editor-version": `vscode/${state.vsCodeVersion}`,
  "editor-plugin-version": "copilot-chat/0.24.1",
  "user-agent": "GitHubCopilotChat/0.24.1",
  "x-github-api-version": "2024-12-15",
  "x-vscode-user-agent-library-version": "electron-fetch",
})

export const GITHUB_BASE_URL = "https://github.com"
export const GITHUB_CLIENT_ID = "Iv1.b507a08c87ecfe98"
export const GITHUB_APP_SCOPES = ["read:user"].join(" ")
