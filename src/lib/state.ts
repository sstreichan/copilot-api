import { randomUUID } from "node:crypto"

import type { ModelsResponse } from "~/services/copilot/get-models"
import type { SmartAgentDecision } from "~/services/github/get-copilot-usage"

export interface State {
  interactionId: string
  githubToken?: string
  copilotToken?: string

  accountType: string
  models?: ModelsResponse
  vsCodeVersion?: string

  manualApprove: boolean
  rateLimitWait: boolean
  showToken: boolean

  // Rate limiting configuration
  rateLimitSeconds?: number
  lastRequestTimestamp?: number
  verbose: boolean
  forceAgent: boolean
  nativeMessages: boolean

  // Smart agent cache (TTL: 3 minutes)
  smartAgentDecision?: SmartAgentDecision | null
  smartAgentCacheTimestamp?: number
}

export const state: State = {
  interactionId: randomUUID(),
  accountType: "individual",
  manualApprove: false,
  rateLimitWait: false,
  showToken: false,
  verbose: false,
  forceAgent: false,
  nativeMessages: false,
}
