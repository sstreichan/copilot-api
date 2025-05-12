import crypto from "node:crypto"

import type { ModelsResponse } from "~/services/copilot/get-models"

export interface State {
  githubToken?: string
  copilotToken?: string

  accountType: string
  models?: ModelsResponse

  vsCodeVersion?: string
  copilotChatVersion?: string
  apiVersion?: string

  manualApprove: boolean
  rateLimitWait: boolean

  // Rate limiting configuration
  rateLimitSeconds?: number
  lastRequestTimestamp?: number

  interactionId: string
  machineId: string
  sessionId: string
}

export const state: State = {
  accountType: "individual",
  manualApprove: false,
  rateLimitWait: false,
  interactionId: crypto.randomUUID(),
  apiVersion: "2025-04-01",
  machineId: "1e712231d95e278befe65dfe8ee74cee238d7fe9c15e816d7aa5489611538de6",
  sessionId: crypto.randomUUID(),
}
