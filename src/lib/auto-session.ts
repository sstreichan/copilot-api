import consola from "consola"

import { getModelsSession } from "~/services/copilot/get-models-session"

import { state } from "./state"

interface AutoSessionCache {
  sessionToken?: string
  availableModels: Set<string>
  expiresAt: number
  hasBeenUsed: boolean
  authToken?: string
}

const cache: AutoSessionCache = {
  sessionToken: undefined,
  availableModels: new Set(),
  expiresAt: 0,
  hasBeenUsed: false,
  authToken: undefined,
}

const FIVE_MINUTES_MS = 5 * 60 * 1000

const refreshAutoSession = async () => {
  const session = await getModelsSession()
  cache.sessionToken = session.session_token
  cache.availableModels = new Set(session.available_models)
  cache.expiresAt = session.expires_at
  cache.hasBeenUsed = false
  cache.authToken = state.copilotToken
  consola.info(
    `[auto-session] refreshed token, models=${cache.availableModels.size}`,
  )
}

export const invalidateAutoSession = (): void => {
  cache.sessionToken = undefined
  cache.availableModels = new Set()
  cache.expiresAt = 0
  cache.hasBeenUsed = false
  cache.authToken = undefined
}

const shouldRefresh = (): boolean => {
  if (!cache.sessionToken) {
    return true
  }

  if (cache.authToken !== state.copilotToken) {
    return true
  }

  const expiresSoon = cache.expiresAt * 1000 - Date.now() < FIVE_MINUTES_MS
  return expiresSoon
}

export const prewarmAutoSession = async (): Promise<void> => {
  try {
    await refreshAutoSession()
  } catch (error) {
    consola.warn("[auto-session] prewarm failed", error)
  }
}

export const isModelAutoCovered = (model: string): boolean => {
  if (cache.availableModels.size === 0) {
    return false
  }

  return cache.availableModels.has(model)
}

export const getAutoSessionTokenForModel = async (
  model: string,
): Promise<string | undefined> => {
  try {
    if (cache.availableModels.size === 0 || !cache.sessionToken) {
      await refreshAutoSession()
    } else if (shouldRefresh()) {
      await refreshAutoSession()
    }
  } catch (error) {
    consola.warn("[auto-session] refresh failed", error)
    return undefined
  }

  if (!isModelAutoCovered(model)) {
    // 模型不在当前 Auto 覆盖集合，保持旧路径行为
    consola.info(`[auto-session] miss model=${model}`)
    return undefined
  }

  // 模型命中 Auto 覆盖集合
  consola.info(`[auto-session] hit model=${model}`)

  const sessionToken = cache.sessionToken
  cache.hasBeenUsed = true
  return sessionToken
}
