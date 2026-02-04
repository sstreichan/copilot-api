import { describe, expect, test } from "bun:test"

import type { Model } from "../src/services/copilot/get-models"

import { formatModelsLog } from "../src/lib/models-log"

function makeModel(args: {
  id: string
  vendor: string
  ctx?: number
  prompt?: number
  output?: number
  premium?: boolean
  preview?: boolean
}): Model {
  return {
    id: args.id,
    name: args.id,
    object: "model",
    vendor: args.vendor,
    version: "1",
    preview: args.preview ?? false,
    model_picker_enabled: true,
    capabilities: {
      family: "gpt",
      object: "capabilities",
      tokenizer: "o200k_base",
      type: "chat",
      supports: {},
      limits: {
        max_context_window_tokens: args.ctx,
        max_prompt_tokens: args.prompt,
        max_output_tokens: args.output,
      },
    },
    billing: {
      is_premium: args.premium ?? false,
      multiplier: 1,
    },
  }
}

describe("formatModelsLog", () => {
  test("prints i/o/c token trio for each model", () => {
    const out = formatModelsLog([
      makeModel({
        id: "gpt-5",
        vendor: "Azure OpenAI",
        ctx: 400_000,
        prompt: 272_000,
        output: 128_000,
        premium: true,
      }),
    ])

    const modelLine = out
      .split("\n")
      .find((l) => l.trimStart().startsWith("gpt-5"))

    expect(modelLine).toBeDefined()
    expect(modelLine).toContain("i272K/o128K/c400K")
    expect(modelLine).not.toContain("·")
    expect(modelLine).toContain("★")
  })

  test("colors premium mark in bold yellow when enabled", () => {
    const out = formatModelsLog(
      [
        makeModel({
          id: "gpt-5",
          vendor: "Azure OpenAI",
          ctx: 400_000,
          prompt: 272_000,
          output: 128_000,
          premium: true,
        }),
      ],
      { color: true },
    )

    const modelLine = out
      .split("\n")
      .find((l) => l.trimStart().startsWith("gpt-5"))

    expect(modelLine).toBeDefined()
    expect(modelLine).toContain("\x1b[1;33m★\x1b[0m")
  })

  test("does not color premium mark when disabled", () => {
    const out = formatModelsLog(
      [
        makeModel({
          id: "gpt-5",
          vendor: "Azure OpenAI",
          ctx: 400_000,
          prompt: 272_000,
          output: 128_000,
          premium: true,
        }),
      ],
      { color: false },
    )

    const modelLine = out
      .split("\n")
      .find((l) => l.trimStart().startsWith("gpt-5"))

    expect(modelLine).toBeDefined()
    expect(modelLine).toContain("★")
    expect(modelLine).not.toContain("\x1b[")
  })

  test("sorts models within a vendor by max_prompt descending", () => {
    const out = formatModelsLog([
      makeModel({
        id: "small-ctx-big-prompt",
        vendor: "Azure OpenAI",
        ctx: 200_000,
        prompt: 190_000,
        output: 10_000,
      }),
      makeModel({
        id: "big-ctx-small-prompt",
        vendor: "Azure OpenAI",
        ctx: 400_000,
        prompt: 50_000,
        output: 350_000,
      }),
    ])

    const iBigPrompt = out.indexOf("small-ctx-big-prompt")
    const iSmallPrompt = out.indexOf("big-ctx-small-prompt")

    expect(iBigPrompt).toBeGreaterThanOrEqual(0)
    expect(iSmallPrompt).toBeGreaterThanOrEqual(0)
    expect(iBigPrompt).toBeLessThan(iSmallPrompt)
  })
})
