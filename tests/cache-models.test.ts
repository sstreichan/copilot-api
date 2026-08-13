import { beforeEach, describe, expect, mock, test } from "bun:test"

import type { ModelsResponse } from "../src/lib/types/models"

import { state } from "../src/lib/state"
import rawModelsResponse from "./fixtures/copilot-models-raw-response.json"

await mock.module("../src/services/copilot/get-models", () => ({
  getModels: () => Promise.resolve(rawModelsResponse as ModelsResponse),
}))

const { cacheModels } = await import("../src/services/copilot/models-cache")

describe("cacheModels", () => {
  beforeEach(() => {
    state.models = undefined
  })

  test("stores picker-enabled and embedding models unless policy-disabled", async () => {
    await cacheModels()

    expect(state.models).not.toBeNull()
    expect(state.models?.data.length).toBeGreaterThan(0)
    expect(
      state.models?.data.every(
        (model) =>
          model.policy?.state !== "disabled"
          && (model.model_picker_enabled
            || model.capabilities.type === "embeddings"),
      ),
    ).toBe(true)

    const expectedCount = (
      rawModelsResponse.data as Array<{
        capabilities?: { type?: string }
        model_picker_enabled?: boolean
        policy?: { state?: string }
      }>
    ).filter(
      (model) =>
        model.policy?.state !== "disabled"
        && (model.model_picker_enabled
          || model.capabilities?.type === "embeddings"),
    ).length

    expect(state.models?.data.length).toBe(expectedCount)
    expect(
      state.models?.data.some(
        (model) => model.capabilities.type === "embeddings",
      ),
    ).toBe(true)
  })
})
