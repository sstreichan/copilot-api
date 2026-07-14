import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test"

import type { ResponsesPayload } from "~/services/copilot/create-responses"

import * as configModule from "~/lib/config"
import {
  preflightResponsesPayload,
  removeUnsupportedTools,
  removeWebSearchTool,
} from "~/routes/responses/preflight"

type WebSearchEnabledSpy = {
  mockRestore: () => void
  mockReturnValue: (value: boolean) => unknown
}

const makePayload = (
  tools?: ResponsesPayload["tools"],
  input?: ResponsesPayload["input"],
): ResponsesPayload =>
  ({
    model: "gpt-5",
    input: input ?? [],
    tools,
  }) as unknown as ResponsesPayload

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

  it("removes image_gen namespace tools", () => {
    const payload = makePayload([
      {
        type: "namespace",
        name: "image_gen",
        tools: [{ type: "function", name: "imagegen" }],
      },
      { type: "function", name: "foo" },
    ] as ResponsesPayload["tools"])

    removeUnsupportedTools(payload)

    expect(payload.tools).toHaveLength(1)
    expect((payload.tools as Array<{ name: string }>)[0].name).toBe("foo")
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
  let isWebSearchEnabledSpy: WebSearchEnabledSpy

  beforeEach(() => {
    isWebSearchEnabledSpy = spyOn(
      configModule,
      "isResponsesApiWebSearchEnabled",
    ).mockReturnValue(true)
  })

  afterEach(() => {
    isWebSearchEnabledSpy.mockRestore()
  })

  it("runs common preflight steps: unsupported tools removed, custom tools preserved, web_search kept when enabled", () => {
    const payload = makePayload([
      { type: "custom", name: "apply_patch" },
      { type: "image_generation" },
      { type: "web_search" },
    ] as ResponsesPayload["tools"])

    preflightResponsesPayload(payload)

    const tools = payload.tools as Array<Record<string, unknown>>
    expect(tools.find((t) => t.name === "apply_patch")?.type).toBe("custom")
    expect(tools.find((t) => t.type === "image_generation")).toBeUndefined()
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

  it("normalizes reasoning items without collapsing replay input", () => {
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
    expect(input[0]).toMatchObject({
      content: "old",
      role: "user",
      type: "message",
    })
    expect(input).toContain(compactionItem)
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
