import { test, expect, describe, mock } from "bun:test"

import type { ModelsResponse } from "../src/services/copilot/get-models"

import { state } from "../src/lib/state"
// Load fixture
import rawModelsResponse from "./fixtures/copilot-models-raw-response.json"

// Mock state
state.copilotToken = "test-token"
state.vsCodeVersion = "1.0.0"
state.accountType = "individual"

// Mock getModels to return fixture data
await mock.module("../src/services/copilot/get-models", () => ({
  getModels: () => Promise.resolve(rawModelsResponse as ModelsResponse),
}))

// Import after mocking
const { modelRoutes } = await import("../src/routes/models/route")

// Response type from our API
interface ModelListResponse {
  object: string
  data: Array<{
    id: string
    object: string
    type: string
    created: number
    created_at: string
    owned_by: string
    display_name: string
    family: string
    preview: boolean
    model_picker_enabled: boolean
    endpoints: Array<string> | null
    supports_tool_calls: boolean
    supports_parallel_tool_calls: boolean
    supports_streaming: boolean
    supports_structured_outputs: boolean
    limits: {
      context_window: number | null
      max_output: number | null
      max_prompt: number | null
      thinking_budget?: { min: number; max: number }
      vision?: {
        max_image_size: number | null
        max_images: number | null
        media_types: Array<string> | null
      }
    }
    is_premium: boolean
    billing_multiplier: number
    available_to: Array<string> | null
  }>
  has_more: boolean
}

// Helper to make request to the route
async function getModelsResponse(): Promise<ModelListResponse> {
  const req = new Request("http://localhost/")
  const res = await modelRoutes.fetch(req)
  return res.json() as Promise<ModelListResponse>
}

describe("GET /models - backward compatibility", () => {
  test("returns original fields for all models", async () => {
    const response = await getModelsResponse()

    expect(response.object).toBe("list")
    expect(response.data).toBeArray()
    expect(response.data.length).toBeGreaterThan(0)

    // Check first model has all original fields
    const model = response.data[0]
    expect(model).toHaveProperty("id")
    expect(model).toHaveProperty("object", "model")
    expect(model).toHaveProperty("type")
    expect(model).toHaveProperty("created")
    expect(model).toHaveProperty("created_at")
    expect(model).toHaveProperty("owned_by")
    expect(model).toHaveProperty("display_name")
  })
})

describe("GET /models - new fields", () => {
  test("includes family field", async () => {
    const response = await getModelsResponse()
    const model = response.data[0]

    expect(model).toHaveProperty("family")
    expect(typeof model.family).toBe("string")
  })

  test("includes preview field", async () => {
    const response = await getModelsResponse()
    const model = response.data[0]

    expect(model).toHaveProperty("preview")
    expect(typeof model.preview).toBe("boolean")
  })

  test("includes model_picker_enabled field", async () => {
    const response = await getModelsResponse()
    const model = response.data[0]

    expect(model).toHaveProperty("model_picker_enabled")
    expect(typeof model.model_picker_enabled).toBe("boolean")
  })

  test("includes endpoints field when available", async () => {
    const response = await getModelsResponse()
    // Find a model with supported_endpoints
    const modelWithEndpoints = response.data.find((m) => m.endpoints !== null)

    expect(modelWithEndpoints).toBeDefined()
    if (modelWithEndpoints) {
      expect(modelWithEndpoints.endpoints).toBeArray()
    }
  })

  test("includes supports_* boolean fields", async () => {
    const response = await getModelsResponse()
    const model = response.data[0]

    expect(model).toHaveProperty("supports_tool_calls")
    expect(model).toHaveProperty("supports_parallel_tool_calls")
    expect(model).toHaveProperty("supports_streaming")
    expect(model).toHaveProperty("supports_structured_outputs")

    expect(typeof model.supports_tool_calls).toBe("boolean")
    expect(typeof model.supports_streaming).toBe("boolean")
  })

  test("includes limits object with core fields", async () => {
    const response = await getModelsResponse()
    const model = response.data[0]

    expect(model).toHaveProperty("limits")
    expect(model.limits).toHaveProperty("context_window")
    expect(model.limits).toHaveProperty("max_output")
    expect(model.limits).toHaveProperty("max_prompt")

    expect(typeof model.limits.context_window).toBe("number")
  })

  test("includes billing fields", async () => {
    const response = await getModelsResponse()
    const model = response.data[0]

    expect(model).toHaveProperty("is_premium")
    expect(model).toHaveProperty("billing_multiplier")

    expect(typeof model.is_premium).toBe("boolean")
    expect(typeof model.billing_multiplier).toBe("number")
  })
})

describe("GET /models - conditional fields", () => {
  test("Claude models have /v1/messages in endpoints", async () => {
    const response = await getModelsResponse()
    const claudeModel = response.data.find((m) => m.id.startsWith("claude-"))

    expect(claudeModel).toBeDefined()
    if (claudeModel) {
      expect(claudeModel.endpoints).toContain("/v1/messages")
    }
  })

  test("models with thinking support have limits.thinking_budget", async () => {
    const response = await getModelsResponse()
    // Claude and Gemini models support thinking
    const claudeModel = response.data.find((m) => m.id.startsWith("claude-"))

    expect(claudeModel).toBeDefined()
    if (claudeModel) {
      expect(claudeModel.limits).toHaveProperty("thinking_budget")
      expect(claudeModel.limits.thinking_budget).toHaveProperty("min")
      expect(claudeModel.limits.thinking_budget).toHaveProperty("max")
    }
  })

  test("models with vision support have limits.vision", async () => {
    const response = await getModelsResponse()
    // Find a model with vision support
    const visionModel = response.data.find((m) => m.limits.vision !== undefined)

    expect(visionModel).toBeDefined()
    if (visionModel) {
      expect(visionModel.limits.vision).toHaveProperty("max_image_size")
      expect(visionModel.limits.vision).toHaveProperty("max_images")
      expect(visionModel.limits.vision).toHaveProperty("media_types")
    }
  })

  test("premium models have available_to field", async () => {
    const response = await getModelsResponse()
    const premiumModel = response.data.find((m) => m.is_premium)

    expect(premiumModel).toBeDefined()
    if (premiumModel) {
      expect(premiumModel).toHaveProperty("available_to")
      expect(premiumModel.available_to).toBeArray()
    }
  })
})

describe("GET /models - all models parsed correctly", () => {
  test("all 40 models from fixture are returned", async () => {
    const response = await getModelsResponse()

    // Fixture has 40 models
    expect(response.data.length).toBe(rawModelsResponse.data.length)
  })

  test("no model has undefined required fields", async () => {
    const response = await getModelsResponse()

    for (const model of response.data) {
      // Required fields should never be undefined
      expect(model.id).toBeDefined()
      expect(model.object).toBe("model")
      expect(model.owned_by).toBeDefined()
      expect(model.family).toBeDefined()
      expect(model.limits).toBeDefined()
      expect(typeof model.is_premium).toBe("boolean")
    }
  })
})

describe("GET /models - sorting", () => {
  test("premium models come before non-premium models", async () => {
    const response = await getModelsResponse()
    const chatModels = response.data.filter((m) => m.type === "chat")

    let sawNonPremium = false
    for (const model of chatModels) {
      if (!model.is_premium) {
        sawNonPremium = true
      }
      // Once we see a non-premium, we shouldn't see premium again
      if (sawNonPremium && model.is_premium) {
        throw new Error(
          `Premium model ${model.id} appears after non-premium models`,
        )
      }
    }
  })

  test("premium models are sorted by max_prompt descending", async () => {
    const response = await getModelsResponse()
    const premiumChatModels = response.data.filter(
      (m) => m.is_premium && m.type === "chat",
    )

    for (let i = 1; i < premiumChatModels.length; i++) {
      const prev = premiumChatModels[i - 1].limits.max_prompt ?? 0
      const curr = premiumChatModels[i].limits.max_prompt ?? 0
      expect(prev).toBeGreaterThanOrEqual(curr)
    }
  })

  test("non-premium chat models are sorted by max_prompt descending", async () => {
    const response = await getModelsResponse()
    const nonPremiumChatModels = response.data.filter(
      (m) => !m.is_premium && m.type === "chat",
    )

    for (let i = 1; i < nonPremiumChatModels.length; i++) {
      const prev = nonPremiumChatModels[i - 1].limits.max_prompt ?? 0
      const curr = nonPremiumChatModels[i].limits.max_prompt ?? 0
      expect(prev).toBeGreaterThanOrEqual(curr)
    }
  })

  test("embedding models come at the end", async () => {
    const response = await getModelsResponse()
    const lastModels = response.data.slice(-5)
    const embeddingCount = lastModels.filter(
      (m) => m.type === "embeddings",
    ).length

    // At least some embedding models should be at the end
    expect(embeddingCount).toBeGreaterThan(0)
  })
})
