import { Hono } from "hono"

import { forwardError } from "~/lib/error"
import { state } from "~/lib/state"
import { cacheModels } from "~/lib/utils"
import { getModelInfo } from "~/services/copilot/get-model-info"

export const modelRoutes = new Hono()

modelRoutes.get("/", async (c) => {
  try {
    if (!state.models) {
      // This should be handled by startup logic, but as a fallback.
      await cacheModels()
    }

    const models = state.models?.data.map((model) => ({
      id: model.id,
      object: "model",
      type: "model",
      created: 0, // No date available from source
      created_at: new Date(0).toISOString(), // No date available from source
      owned_by: model.vendor,
      display_name: model.name,
    }))

    return c.json({
      object: "list",
      data: models,
      has_more: false,
    })
  } catch (error) {
    return await forwardError(c, error)
  }
})

modelRoutes.get("/info", async (c) => {
  try {
    const { model } = c.req.query()

    if (!model) {
      return c.json({ error: "Missing required query parameter: model" }, 400)
    }

    const modelInfo = await getModelInfo(model)
    return c.json(modelInfo)
  } catch (error) {
    return await forwardError(c, error)
  }
})

modelRoutes.get("/:model_id", async (c) => {
  try {
    const modelId = c.req.param("model_id")

    if (!state.models) {
      // This should be handled by startup logic, but as a fallback.
      await cacheModels()
    }

    const model = state.models?.data.find((m) => m.id === modelId)

    if (!model) {
      return c.json({ error: "Model not found" }, 404)
    }

    // Transform to OpenAI API format
    const modelResponse = {
      id: model.id,
      object: "model",
      created: 0, // No date available from source
      owned_by: model.vendor,
    }

    return c.json(modelResponse)
  } catch (error) {
    return await forwardError(c, error)
  }
})

// Additional model info endpoints (not under /models/ prefix)
export const modelInfoRoutes = new Hono()

modelInfoRoutes.get("/model/info", async (c) => {
  try {
    if (!state.models) {
      // This should be handled by startup logic, but as a fallback.
      await cacheModels()
    }

    const modelsToReturn = state.models?.data || []

    // Transform to the expected format with model_info
    const transformedModels = modelsToReturn.map((model) => ({
      model_name: model.id,
      model_info: {
        id: model.id,
        db_model: false, // Default value as per swagger example
      },
    }))

    return c.json({
      data: transformedModels,
    })
  } catch (error) {
    return await forwardError(c, error)
  }
})

modelInfoRoutes.get("/model_group/info", async (c) => {
  try {
    const { model_group } = c.req.query()

    if (!state.models) {
      // This should be handled by startup logic, but as a fallback.
      await cacheModels()
    }

    let modelsToReturn = state.models?.data || []

    // Filter by model group if specified
    if (model_group) {
      modelsToReturn = modelsToReturn.filter(
        (model) => model.id === model_group,
      )
    }

    // Transform to ModelGroupInfoProxy format
    const transformedGroups = modelsToReturn.map((model) => ({
      model_group: model.id,
      providers: [model.vendor],
      max_input_tokens:
        model.capabilities.limits.max_context_window_tokens || null,
      max_output_tokens: model.capabilities.limits.max_output_tokens || null,
      input_cost_per_token: 0.0, // Default pricing
      output_cost_per_token: 0.0, // Default pricing
      mode: model.capabilities.type === "chat" ? "chat" : null,
      tpm: null,
      rpm: null,
      supports_parallel_function_calling:
        model.capabilities.supports.parallel_tool_calls || false,
      supports_vision: false, // Default value
      supports_function_calling:
        model.capabilities.supports.tool_calls || false,
      supported_openai_params: [
        "stream",
        "temperature",
        "max_tokens",
        "logit_bias",
        "top_p",
        "frequency_penalty",
        "presence_penalty",
        "stop",
        "n",
        "extra_headers",
      ], // Default supported params
    }))

    return c.json({
      data: transformedGroups,
    })
  } catch (error) {
    return await forwardError(c, error)
  }
})
