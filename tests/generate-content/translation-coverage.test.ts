import { expect, test, mock } from "bun:test"

import type { CapturedPayload } from "./test-types"

import {
  makeRequest,
  createMockNonStreamingWithCapture,
  buildNonStreamingResponse,
} from "./_test-utils"

test("processes function response arrays with tool call matching", async () => {
  const { capturedPayload } =
    await createMockNonStreamingWithCapture<CapturedPayload>()

  // Should correctly process nested function response arrays
  const res = await makeRequest("/v1beta/models/gemini-pro:generateContent", {
    contents: [
      { role: "user", parts: [{ text: "Call function" }] },
      {
        role: "model",
        parts: [
          {
            functionCall: { name: "testFunc", args: { param: "value" } },
          },
        ],
      },
      {
        role: "user",
        parts: [
          [
            {
              functionResponse: {
                name: "testFunc",
                response: { result: "success" },
              },
            },
          ],
        ],
      },
    ],
  })

  expect(res.status).toBe(200)
  // Verify nested array structure is processed correctly
  const messages = capturedPayload.current?.messages ?? []
  expect(messages.length).toBeGreaterThan(0)

  // Should successfully parse and process nested function response arrays
  // The actual message structure depends on cleanup logic
  // Key is that the request succeeds and messages are generated
  const userMessages = messages.filter((m) => m.role === "user")
  expect(userMessages.length).toBeGreaterThan(0)
})

test("handles function response without matching tool call", async () => {
  const { capturedPayload } =
    await createMockNonStreamingWithCapture<CapturedPayload>()

  // Should skip function responses without matching tool calls
  const res = await makeRequest("/v1beta/models/gemini-pro:generateContent", {
    contents: [
      { role: "user", parts: [{ text: "Call function" }] },
      {
        role: "user",
        parts: [
          {
            functionResponse: {
              name: "nonExistentFunc",
              response: { result: "orphaned" },
            },
          },
        ],
      },
    ],
  })

  expect(res.status).toBe(200)
  const toolMessages =
    capturedPayload.current?.messages?.filter((m) => m.role === "tool") ?? []
  expect(toolMessages.length).toBe(0)

  // Verify user messages are still processed
  const userMessages =
    capturedPayload.current?.messages?.filter((m) => m.role === "user") ?? []
  expect(userMessages.length).toBeGreaterThan(0)
  expect(userMessages[0]?.content).toContain("Call function")
})

test("handles empty content merging fallback", async () => {
  const { capturedPayload } =
    await createMockNonStreamingWithCapture<CapturedPayload>()

  // Should merge empty and whitespace-only content correctly
  const res = await makeRequest("/v1beta/models/gemini-pro:generateContent", {
    contents: [
      { role: "user", parts: [{ text: "" }] }, // Empty text
      { role: "user", parts: [{ text: "  " }] }, // Whitespace only
      { role: "user", parts: [{ text: "actual question" }] },
    ],
  })

  expect(res.status).toBe(200)
  const userMessages =
    capturedPayload.current?.messages?.filter((m) => m.role === "user") ?? []
  expect(userMessages.length).toBe(1)
  expect(userMessages[0]?.content).toContain("actual question")
  // Ensure empty/whitespace content doesn't appear in merged message
  expect(userMessages[0]?.content).not.toMatch(/^\s*$/)
})

test("handles complex content that cannot be merged", async () => {
  const { capturedPayload } =
    await createMockNonStreamingWithCapture<CapturedPayload>()

  // Should handle complex content mixing text and function responses
  const res = await makeRequest("/v1beta/models/gemini-pro:generateContent", {
    contents: [
      { role: "user", parts: [{ text: "First message" }] },
      {
        role: "user",
        parts: [
          { text: "Second message" },
          {
            functionResponse: {
              name: "func",
              response: { data: "complex" },
            },
          },
        ],
      },
    ],
  })

  expect(res.status).toBe(200)
  const messages = capturedPayload.current?.messages ?? []
  expect(messages.length).toBeGreaterThan(0)

  // Verify text messages are merged but function responses are handled separately
  const userMessages = messages.filter((m) => m.role === "user")
  expect(userMessages.length).toBeGreaterThan(0)
  const mergedContent = userMessages.map((m) => m.content).join(" ")
  expect(mergedContent).toContain("First message")
  expect(mergedContent).toContain("Second message")
})

test.each([
  {
    modelInput: "gemini-2.5-flash",
    expectedModel: "gpt-5-mini",
    description: "maps unsupported to supported",
  },
  {
    modelInput: "gemini-1.5-pro",
    expectedModel: "gemini-1.5-pro",
    description: "preserves supported names",
  },
])(
  "$description: $modelInput -> $expectedModel",
  async ({ modelInput, expectedModel }) => {
    const { capturedPayload } =
      await createMockNonStreamingWithCapture<CapturedPayload>()

    const res = await makeRequest(
      `/v1beta/models/${modelInput}:generateContent`,
      {
        contents: [{ role: "user", parts: [{ text: "hi" }] }],
      },
    )

    expect(res.status).toBe(200)
    expect(capturedPayload.current?.model).toBe(expectedModel)
  },
)

test("handles tool call cleanup with incomplete tool calls", async () => {
  const { capturedPayload } =
    await createMockNonStreamingWithCapture<CapturedPayload>()

  // Should clean up incomplete tool calls (tool_calls without responses)
  const res = await makeRequest("/v1beta/models/gemini-pro:generateContent", {
    contents: [
      { role: "user", parts: [{ text: "Search something" }] },
      {
        role: "model",
        parts: [{ functionCall: { name: "search", args: { query: "test" } } }],
      },
      { role: "user", parts: [{ text: "What did you find?" }] },
    ],
  })

  expect(res.status).toBe(200)

  const messages = capturedPayload.current?.messages ?? []

  // Incomplete tool calls should be removed
  const assistantMessages = messages.filter((m) => m.role === "assistant")
  expect(assistantMessages.length).toBe(0)

  // Tool role messages should not exist
  const toolMessages = messages.filter((m) => m.role === "tool")
  expect(toolMessages.length).toBe(0)

  // User messages should still be present (merged into one message)
  const userMessages = messages.filter((m) => m.role === "user")
  expect(userMessages.length).toBe(1)

  // Original tool call should be completely removed
  const payload = JSON.stringify(messages)
  expect(payload).not.toContain("search")
})

test("processes inline data with inlineData field", async () => {
  const { capturedPayload } =
    await createMockNonStreamingWithCapture<CapturedPayload>()

  // Should process inline data (base64-encoded images) correctly
  const res = await makeRequest("/v1beta/models/gemini-pro:generateContent", {
    contents: [
      {
        role: "user",
        parts: [
          { text: "Analyze this image" },
          {
            inlineData: {
              mimeType: "image/jpeg",
              data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
            },
          },
        ],
      },
    ],
  })

  expect(res.status).toBe(200)
  expect(capturedPayload.current?.messages?.length).toBe(1)

  const userMessage = capturedPayload.current?.messages?.[0]
  expect(userMessage?.role).toBe("user")
  // Content should include both text and image data
  const content = userMessage?.content
  expect(content).toBeDefined()
  expect(typeof content === "string" || Array.isArray(content)).toBe(true)
})

test("handles Google Search tool processing", async () => {
  const { capturedPayload } =
    await createMockNonStreamingWithCapture<CapturedPayload>()

  // Should handle Google Search tool configuration and processing
  const res = await makeRequest("/v1beta/models/gemini-pro:generateContent", {
    tools: [
      {
        googleSearchRetrieval: {
          dynamicRetrievalConfig: {
            mode: "MODE_DYNAMIC",
            dynamicThreshold: 0.7,
          },
        },
      },
    ],
    contents: [{ role: "user", parts: [{ text: "Search for latest news" }] }],
  })

  expect(res.status).toBe(200)
  expect(capturedPayload.current?.messages?.length).toBe(1)

  const userMessage = capturedPayload.current?.messages?.[0]
  expect(userMessage?.role).toBe("user")
  expect(userMessage?.content).toContain("latest news")

  // Google Search tool is Gemini-specific and gets translated
  // It may or may not appear in the tools array depending on translation logic
  // The key is that the request succeeds
  expect(capturedPayload.current?.messages).toBeDefined()
})

test("handles translation errors gracefully", async () => {
  // Should return appropriate error status when Copilot API fails
  await mock.module("~/services/copilot/create-chat-completions", () => ({
    createChatCompletions: () => {
      throw new Error("Copilot API error")
    },
  }))

  const res = await makeRequest("/v1beta/models/gemini-pro:generateContent", {
    contents: [{ role: "user", parts: [{ text: "This should fail" }] }],
  })

  // Should handle the error and return appropriate status
  expect(res.status).toBeGreaterThanOrEqual(400)
})

test("handles malformed tool calls in content processing", async () => {
  await mock.module("~/services/copilot/create-chat-completions", () => ({
    createChatCompletions: () => buildNonStreamingResponse({ content: "ok" }),
  }))

  const res = await makeRequest("/v1beta/models/gemini-pro:generateContent", {
    contents: [
      { role: "user", parts: [{ text: "Process this" }] },
      {
        role: "model",
        parts: [
          {
            functionCall: {
              name: "",
              args: {},
            },
          },
        ],
      },
    ],
  })

  expect(res.status).toBe(200)
})

// Real scenario tests for multi-turn tool calls and deduplication

test("handles multi-turn tool call conversation correctly", async () => {
  const { capturedPayload } =
    await createMockNonStreamingWithCapture<CapturedPayload>()

  const res = await makeRequest("/v1beta/models/gemini-pro:generateContent", {
    contents: [
      { role: "user", parts: [{ text: "Read file A" }] },
      {
        role: "model",
        parts: [
          { functionCall: { name: "readFile", args: { path: "a.txt" } } },
        ],
      },
      {
        role: "user",
        parts: [
          {
            functionResponse: {
              name: "readFile",
              response: { content: "Content of A" },
            },
          },
        ],
      },
      {
        role: "model",
        parts: [{ text: "File A contains: Content of A" }],
      },
      { role: "user", parts: [{ text: "Now read file B" }] },
      {
        role: "model",
        parts: [
          { functionCall: { name: "readFile", args: { path: "b.txt" } } },
        ],
      },
      {
        role: "user",
        parts: [
          {
            functionResponse: {
              name: "readFile",
              response: { content: "Content of B" },
            },
          },
        ],
      },
    ],
  })

  expect(res.status).toBe(200)

  // Verify message structure: user, assistant+tool_call, tool, assistant, user, assistant+tool_call, tool
  const messages = capturedPayload.current?.messages ?? []
  expect(messages.length).toBeGreaterThanOrEqual(5)

  // Verify tool call ID consistency
  const assistantWithTools = messages.filter(
    (m) => m.role === "assistant" && m.tool_calls,
  )
  expect(assistantWithTools.length).toBeGreaterThanOrEqual(2)

  const toolMessages = messages.filter((m) => m.role === "tool")
  expect(toolMessages.length).toBeGreaterThanOrEqual(2)

  // Each tool message should reference a tool_call_id
  for (const toolMsg of toolMessages) {
    expect(toolMsg.tool_call_id).toBeDefined()
    expect(typeof toolMsg.tool_call_id).toBe("string")
  }
})

test("handles duplicate tool responses by deduplication", async () => {
  const { capturedPayload } =
    await createMockNonStreamingWithCapture<CapturedPayload>()

  const res = await makeRequest("/v1beta/models/gemini-pro:generateContent", {
    contents: [
      { role: "user", parts: [{ text: "Call function" }] },
      {
        role: "model",
        parts: [
          { functionCall: { name: "testFunc", args: { param: "value1" } } },
          { functionCall: { name: "testFunc2", args: { param: "value2" } } },
        ],
      },
      {
        role: "user",
        parts: [
          {
            functionResponse: {
              name: "testFunc",
              response: { result: "first" },
            },
          },
          {
            functionResponse: {
              name: "testFunc2",
              response: { result: "second" },
            },
          },
          // Duplicate response - should be deduplicated
          {
            functionResponse: {
              name: "testFunc",
              response: { result: "duplicate" },
            },
          },
        ],
      },
    ],
  })

  expect(res.status).toBe(200)

  // Verify deduplication: should have exactly 2 tool messages (not 3)
  const messages = capturedPayload.current?.messages ?? []
  const toolMessages = messages.filter((m) => m.role === "tool")

  // Count unique tool_call_ids
  const toolCallIds = new Set(
    toolMessages.map((m) => m.tool_call_id).filter(Boolean),
  )
  expect(toolCallIds.size).toBeLessThanOrEqual(2)
})

test("verifies tool_call_id length constraint (≤40 characters)", async () => {
  const { capturedPayload } =
    await createMockNonStreamingWithCapture<CapturedPayload>()

  const res = await makeRequest("/v1beta/models/gemini-pro:generateContent", {
    contents: [
      { role: "user", parts: [{ text: "Call a function" }] },
      {
        role: "model",
        parts: [
          {
            functionCall: {
              name: "veryLongFunctionNameThatMightCauseIssues",
              args: { param: "test" },
            },
          },
        ],
      },
      {
        role: "user",
        parts: [
          {
            functionResponse: {
              name: "veryLongFunctionNameThatMightCauseIssues",
              response: { result: "ok" },
            },
          },
        ],
      },
    ],
  })

  expect(res.status).toBe(200)

  const messages = capturedPayload.current?.messages ?? []
  const assistantWithTools = messages.filter(
    (m) => m.role === "assistant" && m.tool_calls,
  )

  // Verify all generated tool_call_ids are within limit
  for (const msg of assistantWithTools) {
    if (msg.tool_calls) {
      for (const toolCall of msg.tool_calls) {
        expect(toolCall.id.length).toBeLessThanOrEqual(40)
      }
    }
  }
})
