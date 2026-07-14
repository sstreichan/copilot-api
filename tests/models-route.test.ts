import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { Hono } from "hono"

import type { ResolvedProviderConfig } from "../src/lib/config"
import type { ModelsResponse } from "../src/services/copilot/get-models"

import rawModelsResponse from "./fixtures/copilot-models-raw-response.json"

const actualConfigModule = await import("../src/lib/config")
const actualTokenModule = await import("../src/lib/token")

let enabledProviders: Array<string> = []
let providerConfigs: Record<string, ResolvedProviderConfig | null> = {}

await mock.module("~/lib/config", () => ({
  ...actualConfigModule,
  getProviderConfig: (provider: string) => providerConfigs[provider] ?? null,
  getRawProviderConfig: (provider: string) => providerConfigs[provider] ?? null,
  listEnabledProviders: () => enabledProviders,
}))

await mock.module("~/lib/token", () => ({
  ...actualTokenModule,
  setupCodexToken: async () => {},
}))

await mock.module("../src/services/copilot/get-models", () => ({
  getModels: () => Promise.resolve(rawModelsResponse as ModelsResponse),
}))

const { state } = await import("../src/lib/state")
const { modelRoutes } = await import("../src/routes/models/route")
const { providerModelRoutes } = await import(
  "../src/routes/provider/models/route"
)

// Dev-side global state setup
state.copilotToken = "test-token"
state.vsCodeVersion = "1.0.0"
state.accountType = "individual"

const originalFetch = globalThis.fetch

const createProviderConfig = (
  name: string,
  baseUrl: string,
): ResolvedProviderConfig => ({
  apiKey: `${name}-key`,
  authType: "authorization",
  baseUrl,
  name,
  type: "openai-compatible",
})

const createCopilotModels = (ids: Array<string>): ModelsResponse => ({
  object: "list",
  data: ids.map((id) => ({
    capabilities: {
      family: "gpt",
      limits: {
        max_context_window_tokens: 200_000,
      },
      object: "model_capabilities",
      supports: {},
      tokenizer: "o200k_base",
      type: "chat",
    },
    id,
    model_picker_enabled: true,
    name: id,
    object: "model",
    preview: false,
    vendor: "openai",
    version: "test",
  })),
})

const fetchMock = mock((url: string | URL | Request, _init?: RequestInit) => {
  const requestUrl =
    typeof url === "string" ? url
    : url instanceof URL ? url.toString()
    : url.url

  if (requestUrl === "https://bad.example/v1/models") {
    return Promise.resolve(new Response("upstream failed", { status: 502 }))
  }

  const providerModelIds: Record<string, string> = {
    "first.example": "first-model",
    "second.example": "second-model",
  }
  const providerModelId =
    providerModelIds[new URL(requestUrl).host] ?? "qwen-plus"

  return Promise.resolve(
    Response.json({
      object: "list",
      data: [
        {
          id: providerModelId,
          name: providerModelId,
          object: "model",
        },
        {
          id: "",
          object: "model",
        },
      ],
    }),
  )
})

const providerFetch: typeof fetch = Object.assign(fetchMock, {
  preconnect: originalFetch.preconnect,
})

function createApp() {
  const app = new Hono()
  app.route("/v1/models", modelRoutes)
  app.route("/:provider/v1/models", providerModelRoutes)
  return app
}

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

beforeEach(() => {
  enabledProviders = []
  providerConfigs = {}
  state.models = undefined
  fetchMock.mockClear()
  globalThis.fetch = providerFetch
})

afterEach(() => {
  globalThis.fetch = originalFetch
  state.models = undefined
  state.codexAccessToken = undefined
  state.codexAccountId = undefined
})

describe("model routes", () => {
  test("aggregates Copilot and provider models without mutating state.models", async () => {
    state.models = createCopilotModels(["gpt-5-mini"])
    enabledProviders = ["dash"]
    providerConfigs = {
      dash: createProviderConfig("dash", "https://dash.example"),
    }

    const response = await createApp().request("/v1/models")

    expect(response.status).toBe(200)
    const body = (await response.json()) as { data: Array<{ id: string }> }
    expect(body.data.map((model) => model.id)).toEqual([
      "gpt-5-mini",
      "dash/qwen-plus",
    ])
    expect(state.models.data.map((model) => model.id)).toEqual(["gpt-5-mini"])
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://dash.example/v1/models")
  })

  test("keeps Copilot models first and provider models in provider order", async () => {
    state.models = createCopilotModels(["gpt-5-mini", "gpt-5"])
    enabledProviders = ["second", "first"]
    providerConfigs = {
      first: createProviderConfig("first", "https://first.example"),
      second: createProviderConfig("second", "https://second.example"),
    }

    const response = await createApp().request("/v1/models")

    expect(response.status).toBe(200)
    const body = (await response.json()) as { data: Array<{ id: string }> }
    expect(body.data.map((model) => model.id)).toEqual([
      "gpt-5-mini",
      "gpt-5",
      "second/second-model",
      "first/first-model",
    ])
  })

  test("returns provider models in provider-only mode and skips failed providers", async () => {
    enabledProviders = ["bad", "dash"]
    providerConfigs = {
      bad: createProviderConfig("bad", "https://bad.example"),
      dash: createProviderConfig("dash", "https://dash.example"),
    }

    const response = await createApp().request("/v1/models")

    expect(response.status).toBe(200)
    const body = (await response.json()) as { data: Array<{ id: string }> }
    expect(body.data.map((model) => model.id)).toEqual(["dash/qwen-plus"])
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  test("adds built-in Codex provider models without calling upstream", async () => {
    enabledProviders = ["codex"]
    providerConfigs = {
      codex: {
        apiKey: "codex-token",
        authType: "oauth2",
        baseUrl: "https://chatgpt.com/backend-api",
        name: "codex",
        type: "openai-responses",
      },
    }

    const response = await createApp().request("/v1/models")

    expect(response.status).toBe(200)
    const body = (await response.json()) as { data: Array<{ id: string }> }
    expect(body.data.map((model) => model.id)).toContain("codex/gpt-5.4")
    expect(body.data.map((model) => model.id)).toContain("codex/gpt-5.6-sol")
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test("forwards Codex clients to the fixed Codex models endpoint", async () => {
    providerConfigs = {
      codex: {
        apiKey: "codex-token",
        authType: "oauth2",
        baseUrl: "https://ignored.example/backend-api",
        name: "codex",
        type: "openai-responses",
      },
    }
    state.codexAccessToken = "codex-access-token"
    state.codexAccountId = "account-123"

    const response = await createApp().request("/v1/models?client=codex", {
      headers: {
        accept: "*/*",
        "user-agent": "codex-tui/0.144.1",
      },
    })

    expect(response.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://chatgpt.com/backend-api/codex/models?client=codex",
    )
    const headers = new Headers(fetchMock.mock.calls[0]?.[1]?.headers)
    expect(headers.get("authorization")).toBe("Bearer codex-access-token")
    expect(headers.get("chatgpt-account-id")).toBe("account-123")
    expect(headers.get("accept")).toBe("*/*")
  })

  test("forwards Codex clients on the provider-scoped models route", async () => {
    providerConfigs = {
      codex: {
        apiKey: "codex-token",
        authType: "oauth2",
        baseUrl: "https://ignored.example/backend-api",
        name: "codex",
        type: "openai-responses",
      },
    }
    state.codexAccessToken = "codex-access-token"
    state.codexAccountId = "account-123"

    const response = await createApp().request(
      "/codex/v1/models?client=codex",
      {
        headers: {
          accept: "*/*",
          "user-agent": "codex-tui/0.144.1",
        },
      },
    )

    expect(response.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://chatgpt.com/backend-api/codex/models?client=codex",
    )
    const headers = new Headers(fetchMock.mock.calls[0]?.[1]?.headers)
    expect(headers.get("authorization")).toBe("Bearer codex-access-token")
    expect(headers.get("chatgpt-account-id")).toBe("account-123")
  })

  test("returns built-in Codex models on the provider route without Codex UA", async () => {
    providerConfigs = {
      codex: {
        apiKey: "codex-token",
        authType: "oauth2",
        baseUrl: "https://ignored.example/backend-api",
        name: "codex",
        type: "openai-responses",
      },
    }

    const response = await createApp().request("/codex/v1/models")

    expect(response.status).toBe(200)
    const body = (await response.json()) as { data: Array<{ id: string }> }
    expect(body.data.map((model) => model.id)).toContain("gpt-5.4")
    expect(body.data.map((model) => model.id)).toContain("gpt-5.6-sol")
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

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
  test("returns only model_picker_enabled models from fixture", async () => {
    const response = await getModelsResponse()

    const expectedCount = (
      rawModelsResponse.data as Array<{ model_picker_enabled?: boolean }>
    ).filter((m) => m.model_picker_enabled).length
    expect(response.data.length).toBe(expectedCount)
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

  test("embedding models come at the end (if any pass model_picker_enabled)", async () => {
    const response = await getModelsResponse()
    const embeddingModels = response.data.filter((m) => m.type === "embeddings")

    if (embeddingModels.length === 0) {
      // All embedding models filtered out by model_picker_enabled — nothing to assert
      return
    }

    const lastModels = response.data.slice(-embeddingModels.length)
    expect(lastModels.every((m) => m.type === "embeddings")).toBe(true)
  })
})
