import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test"

import type { ResponsesPayload } from "~/services/copilot/create-responses"

import * as configModule from "~/lib/config"
import * as loggerModule from "~/lib/logger"
import {
  preflightResponsesPayload,
  removeUnsupportedTools,
  removeWebSearchTool,
  useFunctionApplyPatch,
} from "~/routes/responses/preflight"

const makePayload = (
  tools?: ResponsesPayload["tools"],
  input?: ResponsesPayload["input"],
): ResponsesPayload =>
  ({
    model: "gpt-5",
    input: input ?? [],
    tools,
  }) as unknown as ResponsesPayload

describe("useFunctionApplyPatch", () => {
  let getConfigSpy: ReturnType<typeof spyOn<typeof configModule, "getConfig">>
  let loggerSpy: ReturnType<
    typeof spyOn<typeof loggerModule, "createHandlerLogger">
  >

  beforeEach(() => {
    getConfigSpy = spyOn(configModule, "getConfig").mockReturnValue({
      ...configModule.getConfig(),
      useFunctionApplyPatch: true,
    })
    loggerSpy = spyOn(loggerModule, "createHandlerLogger").mockReturnValue({
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
    } as unknown as ReturnType<typeof loggerModule.createHandlerLogger>)
  })

  afterEach(() => {
    getConfigSpy.mockRestore()
    loggerSpy.mockRestore()
  })

  it("rewrites apply_patch custom tool to function tool", () => {
    const payload = makePayload([
      { type: "custom", name: "apply_patch" },
      { type: "custom", name: "other_tool" },
    ] as ResponsesPayload["tools"])

    useFunctionApplyPatch(payload)

    const tools = payload.tools as Array<Record<string, unknown>>
    expect(tools[0].type).toBe("function")
    expect(tools[0].name).toBe("apply_patch")
    expect(tools[0].description).toBe(
      "Use the `apply_patch` tool to edit files",
    )
    expect(tools[0].strict).toBe(false)
    const params = tools[0].parameters as Record<string, unknown>
    expect(params.type).toBe("object")
    // non-apply_patch custom tool is untouched
    expect(tools[1].type).toBe("custom")
  })

  it("does not rewrite when useFunctionApplyPatch config is false", () => {
    getConfigSpy.mockReturnValue({
      ...configModule.getConfig(),
      useFunctionApplyPatch: false,
    })
    const payload = makePayload([
      { type: "custom", name: "apply_patch" },
    ] as ResponsesPayload["tools"])

    useFunctionApplyPatch(payload)

    const tools = payload.tools as Array<Record<string, unknown>>
    expect(tools[0].type).toBe("custom")
  })

  it("is a no-op when tools is missing", () => {
    const payload = { model: "gpt-5", input: [] } as unknown as ResponsesPayload
    useFunctionApplyPatch(payload)
    expect(payload.tools).toBeUndefined()
  })
})

describe("removeUnsupportedTools", () => {
  it("removes image_generation tools", () => {
    const payload = makePayload([
      { type: "image_generation" },
      { type: "function", name: "foo" },
    ] as ResponsesPayload["tools"])

    removeUnsupportedTools(payload)

    expect(payload.tools).toHaveLength(1)
    expect((payload.tools as Array<{ type: string }>)[0].type).toBe("function")
  })

  it("is a no-op when tools is empty or missing", () => {
    const empty = makePayload([] as ResponsesPayload["tools"])
    removeUnsupportedTools(empty)
    expect(empty.tools).toEqual([])

    const missing = { model: "gpt-5", input: [] } as unknown as ResponsesPayload
    removeUnsupportedTools(missing)
    expect(missing.tools).toBeUndefined()
  })
})

describe("removeWebSearchTool", () => {
  it("removes web_search tools from payload", () => {
    const payload = makePayload([
      { type: "web_search" },
      { type: "function", name: "foo" },
    ] as ResponsesPayload["tools"])

    removeWebSearchTool(payload)

    expect(payload.tools).toHaveLength(1)
    expect((payload.tools as Array<{ type: string }>)[0].type).toBe("function")
  })

  it("is a no-op when tools is empty", () => {
    const payload = makePayload([] as ResponsesPayload["tools"])
    removeWebSearchTool(payload)
    expect(payload.tools).toHaveLength(0)
  })
})

describe("preflightResponsesPayload", () => {
  let getConfigSpy: ReturnType<typeof spyOn<typeof configModule, "getConfig">>
  let isWebSearchEnabledSpy: ReturnType<
    typeof spyOn<typeof configModule, "isResponsesApiWebSearchEnabled">
  >

  beforeEach(() => {
    getConfigSpy = spyOn(configModule, "getConfig").mockReturnValue({
      ...configModule.getConfig(),
      useFunctionApplyPatch: true,
    })
    isWebSearchEnabledSpy = spyOn(
      configModule,
      "isResponsesApiWebSearchEnabled",
    ).mockReturnValue(true)
  })

  afterEach(() => {
    getConfigSpy.mockRestore()
    isWebSearchEnabledSpy.mockRestore()
  })

  it("runs all 5 steps in order: apply_patch rewritten, image_generation removed, web_search kept when enabled", () => {
    const payload = makePayload([
      { type: "custom", name: "apply_patch" },
      { type: "image_generation" },
      { type: "web_search" },
    ] as ResponsesPayload["tools"])

    preflightResponsesPayload(payload)

    const tools = payload.tools as Array<Record<string, unknown>>
    // apply_patch rewritten
    expect(tools.find((t) => t.name === "apply_patch")?.type).toBe("function")
    // image_generation removed
    expect(tools.find((t) => t.type === "image_generation")).toBeUndefined()
    // web_search kept because isResponsesApiWebSearchEnabled() = true
    expect(tools.find((t) => t.type === "web_search")).toBeDefined()
  })

  it("removes web_search when web search is disabled", () => {
    isWebSearchEnabledSpy.mockReturnValue(false)
    const payload = makePayload([
      { type: "web_search" },
      { type: "function", name: "foo" },
    ] as ResponsesPayload["tools"])

    preflightResponsesPayload(payload)

    const tools = payload.tools as Array<Record<string, unknown>>
    expect(tools.find((t) => t.type === "web_search")).toBeUndefined()
    expect(tools.find((t) => t.name === "foo")).toBeDefined()
  })

  it("normalizes reasoning items and collapses compaction in input", () => {
    const compactionItem = { type: "compaction", summary: "old summary" }
    const reasoningItem = {
      type: "reasoning",
      id: "r1",
      summary: undefined,
    }
    const userItem = { type: "message", role: "user", content: "hello" }

    const payload = makePayload(undefined, [
      { type: "message", role: "user", content: "old" },
      compactionItem,
      reasoningItem,
      userItem,
    ] as unknown as ResponsesPayload["input"])

    preflightResponsesPayload(payload)

    expect(Array.isArray(payload.input)).toBe(true)
    const input = payload.input as Array<Record<string, unknown>>
    // compactInputByLatestCompaction: input starts from compaction item
    expect(input[0].type).toBe("compaction")
    // normalizeResponsesInputForReplay: reasoning item summary normalized to []
    const normalized = input.find((i) => i.type === "reasoning") as Record<
      string,
      unknown
    >
    expect(normalized).toBeDefined()
    expect(normalized.summary).toEqual([])
    expect(normalized.id).toBe("r1")
  })

  it("is safe with empty tools and empty input", () => {
    const payload = makePayload([], [])
    expect(() => preflightResponsesPayload(payload)).not.toThrow()
    expect(payload.tools).toEqual([])
    expect(payload.input).toEqual([])
  })
})
