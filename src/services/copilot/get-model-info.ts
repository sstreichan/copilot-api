import { HTTPError } from "~/lib/error"
import { state } from "~/lib/state"
import { cacheModels } from "~/lib/utils"

import type { Model } from "./get-models"

export const getModelInfo = async (modelId: string): Promise<Model> => {
  if (!state.models) {
    // This should be handled by startup logic, but as a fallback.
    await cacheModels()
  }

  const model = state.models?.data.find((m) => m.id === modelId)

  if (!model) {
    throw new HTTPError(
      `Model '${modelId}' not found`,
      new Response("Model not found", { status: 404 }),
    )
  }

  return model
}
