import { Hono } from "hono"

import type { Model } from "~/services/copilot/get-models"

import { forwardError } from "~/lib/error"
import { state } from "~/lib/state"
import { cacheModels } from "~/lib/utils"

export const modelRoutes = new Hono()

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

  // Add thinking_budget if model supports thinking
  if (
    caps.supports.max_thinking_budget !== undefined
    && caps.supports.min_thinking_budget !== undefined
  ) {
    limits.thinking_budget = {
      min: caps.supports.min_thinking_budget,
      max: caps.supports.max_thinking_budget,
    }
  }

  // Add vision if model supports vision
  if (rawLimits.vision) {
    limits.vision = {
      max_image_size: rawLimits.vision.max_prompt_image_size ?? null,
      max_images: rawLimits.vision.max_prompt_images ?? null,
      media_types: rawLimits.vision.supported_media_types ?? null,
    }
  }

  return limits
}

interface TransformedModel {
  id: string
  type: string
  is_premium: boolean
  limits: Record<string, unknown>
}

function sortModels<T extends TransformedModel>(models: Array<T>): Array<T> {
  return models.sort((a, b) => {
    // 1. Chat models first, embeddings/completion last
    const typeOrder: Record<string, number> = {
      chat: 0,
      completion: 1,
      embeddings: 2,
    }
    const aTypeOrder = typeOrder[a.type] ?? 1
    const bTypeOrder = typeOrder[b.type] ?? 1
    if (aTypeOrder !== bTypeOrder) return aTypeOrder - bTypeOrder

    // 2. Premium before non-premium (within same type)
    if (a.is_premium !== b.is_premium) return a.is_premium ? -1 : 1

    // 3. Sort by context_window descending
    const aContext = Number(a.limits.context_window) || 0
    const bContext = Number(b.limits.context_window) || 0
    return bContext - aContext
  })
}

modelRoutes.get("/", async (c) => {
  try {
    if (!state.models) {
      // This should be handled by startup logic, but as a fallback.
      await cacheModels()
    }

    const models = state.models?.data.map((model) => ({
      // Original fields (backward compatible)
      id: model.id,
      object: "model",
      type: model.capabilities.type,
      created: 0, // No date available from source
      created_at: new Date(0).toISOString(), // No date available from source
      owned_by: model.vendor,
      display_name: model.name,

      // New fields
      family: model.capabilities.family,
      preview: model.preview,
      model_picker_enabled: model.model_picker_enabled,
      endpoints: model.supported_endpoints ?? null,

      // Capability flags
      supports_tool_calls: model.capabilities.supports.tool_calls ?? false,
      supports_parallel_tool_calls:
        model.capabilities.supports.parallel_tool_calls ?? false,
      supports_streaming: model.capabilities.supports.streaming ?? false,
      supports_structured_outputs:
        model.capabilities.supports.structured_outputs ?? false,

      // Limits
      limits: buildLimits(model),

      // Billing
      is_premium: model.billing?.is_premium ?? false,
      billing_multiplier: model.billing?.multiplier ?? 0,
      available_to: model.billing?.restricted_to ?? null,
    }))

    const sortedModels = sortModels(models as Array<TransformedModel>)

    return c.json({
      object: "list",
      data: sortedModels,
      has_more: false,
    })
  } catch (error) {
    return await forwardError(c, error)
  }
})
