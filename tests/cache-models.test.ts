import { beforeEach, describe, expect, mock, test } from "bun:test"

import type { ModelsResponse } from "../src/services/copilot/get-models"

import { state } from "../src/lib/state"
import rawModelsResponse from "./fixtures/copilot-models-raw-response.json"

await mock.module("../src/services/copilot/get-models", () => ({
  getModels: () => Promise.resolve(rawModelsResponse as ModelsResponse),
}))

const { cacheModels } = await import("../src/lib/utils")

describe("cacheModels", () => {
  beforeEach(() => {
    state.models = undefined
  })

  test("stores only model_picker_enabled models in state", async () => {
    await cacheModels()

    expect(state.models).not.toBeNull()
    expect(state.models?.data.length).toBeGreaterThan(0)
    expect(
      state.models?.data.every((model) => model.model_picker_enabled),
    ).toBe(true)

    const expectedCount = (
      rawModelsResponse.data as Array<{ model_picker_enabled?: boolean }>
    ).filter((model) => model.model_picker_enabled).length

    expect(state.models?.data.length).toBe(expectedCount)
  })
})
