import consola from "consola"

import { getModelsSession } from "~/services/copilot/get-models-session"

interface AutoSessionCache {
  sessionToken?: string
  availableModels: Set<string>
  expiresAt: number
  hasBeenUsed: boolean
}

const cache: AutoSessionCache = {
  sessionToken: undefined,
  availableModels: new Set(),
  expiresAt: 0,
  hasBeenUsed: false,
}

const FIVE_MINUTES_MS = 5 * 60 * 1000

const refreshAutoSession = async () => {
  const session = await getModelsSession()
  cache.sessionToken = session.session_token
  cache.availableModels = new Set(session.available_models)
  cache.expiresAt = session.expires_at
  cache.hasBeenUsed = false
  consola.info(
    `[auto-session] refreshed token, models=${cache.availableModels.size}`,
  )
}

const shouldRefresh = (): boolean => {
  if (!cache.sessionToken) {
    return true
  }

  const expiresSoon = cache.expiresAt * 1000 - Date.now() < FIVE_MINUTES_MS
  return expiresSoon && cache.hasBeenUsed
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
