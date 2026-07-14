import { Hono } from "hono"

import { listEnabledProviders } from "~/lib/config"
import { forwardError } from "~/lib/error"
import { createHandlerLogger } from "~/lib/logger"
import { toClientModelId } from "~/lib/models"
import { resolveProviderConfig } from "~/lib/provider-resolver"
import { state } from "~/lib/state"
import { cacheModels } from "~/lib/utils"
import type { Model } from "~/services/copilot/get-models"
import { getModels as getCodexModels } from "~/services/codex/get-models"
import { forwardProviderModels } from "~/services/providers/provider-proxy"

import { handleCodexModelsProxy, isCodexUserAgent } from "./codex-models"

export const modelRoutes = new Hono()

const logger = createHandlerLogger("models-handler")
const EPOCH_ISO = new Date(0).toISOString()

type ClientModel = Record<string, unknown> & {
  id: string
  object: string
  type: string
  is_premium: boolean
  limits: Record<string, unknown>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function buildLimits(model: Model) {
  const caps = model.capabilities
  // Runtime defensive: some models (e.g., embeddings) may lack limits in practice
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  const rawLimits = caps.limits ?? {}
  const limits: Record<string, unknown> = {
    context_window: rawLimits.max_context_window_tokens ?? null,
    max_output: rawLimits.max_output_tokens ?? null,
    max_prompt: rawLimits.max_prompt_tokens ?? null,
  }

  if (
    caps.supports.max_thinking_budget !== undefined
    && caps.supports.min_thinking_budget !== undefined
  ) {
    limits.thinking_budget = {
      min: caps.supports.min_thinking_budget,
      max: caps.supports.max_thinking_budget,
    }
  }

  if (rawLimits.vision) {
    limits.vision = {
      max_image_size: rawLimits.vision.max_prompt_image_size ?? null,
      max_images: rawLimits.vision.max_prompt_images ?? null,
      media_types: rawLimits.vision.supported_media_types ?? null,
    }
  }

  return limits
}
function normalizeCopilotModel(model: Model): ClientModel {
  const capabilities = model.capabilities
  const contextWindow = capabilities?.limits?.max_context_window_tokens ?? 0
  const clientId = toClientModelId(model.id)
  const is1m = contextWindow >= 1_000_000

  return {
    claude_model_id: is1m ? `${clientId}[1m]` : clientId,
    ...model,
    id: clientId,
    object: "model",
    type: model.capabilities.type,
    created: 0,
    created_at: EPOCH_ISO,
    owned_by: model.vendor,
    display_name: model.name,
    family: model.capabilities.family,
    preview: model.preview,
    model_picker_enabled: model.model_picker_enabled,
    endpoints: model.supported_endpoints ?? null,
    supports_tool_calls: model.capabilities.supports.tool_calls ?? false,
    supports_parallel_tool_calls:
      model.capabilities.supports.parallel_tool_calls ?? false,
    supports_streaming: model.capabilities.supports.streaming ?? false,
    supports_structured_outputs:
      model.capabilities.supports.structured_outputs ?? false,
    limits: buildLimits(model),
    is_premium: model.billing?.is_premium ?? false,
    billing_multiplier: model.billing?.multiplier ?? 0,
    available_to: model.billing?.restricted_to ?? null,
  }
}

function getStringField(
  model: Record<string, unknown>,
  field: string,
): string | undefined {
  const value = model[field]
  return typeof value === "string" && value.trim() ? value : undefined
}

function normalizeProviderModel(
  provider: string,
  model: unknown,
): ClientModel | null {
  if (!isRecord(model)) {
    return null
  }

  const rawId = getStringField(model, "id")
  if (!rawId) {
    return null
  }

  const id = `${provider}/${rawId}`
  const name =
    getStringField(model, "display_name")
    ?? getStringField(model, "name")
    ?? rawId
  const ownedBy =
    getStringField(model, "owned_by")
    ?? getStringField(model, "vendor")
    ?? provider

  return {
    ...model,
    id,
    object: getStringField(model, "object") ?? "model",
    type: getStringField(model, "type") ?? "model",
    created: typeof model.created === "number" ? model.created : 0,
    created_at: getStringField(model, "created_at") ?? EPOCH_ISO,
    owned_by: ownedBy,
    display_name: name,
    is_premium:
      typeof model.is_premium === "boolean" ? model.is_premium : false,
    limits: isRecord(model.limits) ? model.limits : {},
  }
}

async function getProviderModels(
  provider: string,
  requestHeaders: Headers,
): Promise<Array<ClientModel>> {
  try {
    const providerConfig = await resolveProviderConfig(provider)
    if (!providerConfig) {
      return []
    }

    if (providerConfig.name === "codex") {
      const codexModels = getCodexModels().data
      return codexModels
        .map((model) => normalizeProviderModel(providerConfig.name, model))
        .filter((model): model is ClientModel => model !== null)
    }

    const response = await forwardProviderModels(providerConfig, requestHeaders)
    if (!response.ok) {
      logger.warn("models.provider.skip_non_ok", {
        provider,
        statusCode: response.status,
      })
      return []
    }

    const body = await response.json()
    if (!isRecord(body) || !Array.isArray(body.data)) {
      logger.warn("models.provider.skip_invalid_body", { provider })
      return []
    }

    return body.data
      .map((model) => normalizeProviderModel(providerConfig.name, model))
      .filter((model): model is ClientModel => model !== null)
  } catch (error) {
    logger.warn("models.provider.skip_error", {
      provider,
      error,
    })
    return []
  }
}

interface TransformedModel {
  id: string
  type: string
  is_premium: boolean
  limits: Record<string, unknown>
}

function sortModels<T extends TransformedModel>(models: Array<T>): Array<T> {
  return models.sort((a, b) => {
    const typeOrder: Record<string, number> = {
      chat: 0,
      completion: 1,
      embeddings: 2,
    }
    const aTypeOrder = typeOrder[a.type] ?? 1
    const bTypeOrder = typeOrder[b.type] ?? 1
    if (aTypeOrder !== bTypeOrder) return aTypeOrder - bTypeOrder

    if (a.is_premium !== b.is_premium) return a.is_premium ? -1 : 1

    const aPrompt = Number(a.limits.max_prompt) || 0
    const bPrompt = Number(b.limits.max_prompt) || 0
    if (aPrompt !== bPrompt) return bPrompt - aPrompt

    const aContext = Number(a.limits.context_window) || 0
    const bContext = Number(b.limits.context_window) || 0
    return bContext - aContext
  })
}

async function getAggregatedModels(
  requestHeaders: Headers,
): Promise<Array<ClientModel>> {
  const enabledProviders = listEnabledProviders()
  if (!state.models && enabledProviders.length === 0) {
    await cacheModels()
  }
  const copilotModels = state.models?.data.map(normalizeCopilotModel) ?? []
  const providerModelsByProvider = await Promise.all(
    enabledProviders.map((provider) =>
      getProviderModels(provider, requestHeaders),
    ),
  )

  const models = [...copilotModels, ...providerModelsByProvider.flat()]

  const seenModelIds = new Set<string>()
  return models.filter((model) => {
    if (seenModelIds.has(model.id)) {
      return false
    }

    seenModelIds.add(model.id)
    return true
  })
}

modelRoutes.get("/", async (c) => {
  try {
    if (isCodexUserAgent(c.req.header("user-agent"))) {
      return await handleCodexModelsProxy(c)
    }

    const models = await getAggregatedModels(c.req.raw.headers)
    const sortedModels = sortModels(models)

    return c.json({
      object: "list",
      data: sortedModels,
      has_more: false,
    })
  } catch (error) {
    return await forwardError(c, error)
  }
})
