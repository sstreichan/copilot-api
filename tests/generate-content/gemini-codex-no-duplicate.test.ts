import { expect, test, mock } from "bun:test"

import type { CapturedPayload } from "./test-types"

import { makeRequest, createMockRateLimit } from "./_test-utils"

test("does not duplicate extra prompt when marker already exists", async () => {
  await createMockRateLimit()
  let capturedPayload: CapturedPayload = {} as CapturedPayload

  // Mock createResponses since codex models use Responses API
  await mock.module("~/services/copilot/create-responses", () => ({
    createResponses: (payload: CapturedPayload) => {
      capturedPayload = payload
      return {
        id: "test-id",
        output: [
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "ok" }],
          },
        ],
        usage: { input_tokens: 10, output_tokens: 5 },
      }
    },
  }))

  // System instruction already contains the marker (simulating previous injection)
  const systemWithMarker = `You are a coding assistant.

## Tool use
- Use tools when available.

<!-- CODEX_EXTRA_PROMPT_INJECTED -->`

  const response = await makeRequest(
    "/v1beta/models/gemini-2.5-codex:generateContent",
    {
      systemInstruction: {
        parts: [{ text: systemWithMarker }],
      },
      contents: [{ role: "user", parts: [{ text: "Hello" }] }],
    },
  )

  expect(response.status).toBe(200)

  // Responses API uses instructions field instead of messages
  expect(capturedPayload.instructions).toBeDefined()

  const instructions = capturedPayload.instructions as string

  // Verify content is unchanged (no duplicate injection)
  expect(instructions).toBe(systemWithMarker)

  // Count occurrences of marker (should be exactly 1)
  const markerCount = (
    instructions.match(/<!-- CODEX_EXTRA_PROMPT_INJECTED -->/g) || []
  ).length
  expect(markerCount).toBe(1)

  // Count occurrences of "## Tool use" (should be exactly 1)
  const toolUseCount = (instructions.match(/## Tool use/g) || []).length
  expect(toolUseCount).toBe(1)
})

test("does not inject extra prompt for non-codex models", async () => {
  await createMockRateLimit()
  let capturedPayload: CapturedPayload = {} as CapturedPayload
  await mock.module("~/services/copilot/create-chat-completions", () => ({
    createChatCompletions: (payload: CapturedPayload) => {
      capturedPayload = payload
      return {
        id: "test-id",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "ok" },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      }
    },
  }))

  const response = await makeRequest(
    "/v1beta/models/gemini-2.5-flash:generateContent",
    {
      systemInstruction: {
        parts: [{ text: "You are a helpful assistant." }],
      },
      contents: [{ role: "user", parts: [{ text: "Hello" }] }],
    },
  )

  expect(response.status).toBe(200)

  if (!capturedPayload.messages) {
    throw new Error("messages is undefined")
  }
  const firstMessage = capturedPayload.messages[0]
  expect(firstMessage.role).toBe("system")

  const systemContent = firstMessage.content

  // Verify original instruction is preserved
  expect(systemContent).toContain("You are a helpful assistant.")

  // Verify NO extra prompt was injected (flash model doesn't get extra prompt)
  expect(systemContent).not.toContain("## Tool use")
  expect(systemContent).not.toContain("<!-- CODEX_EXTRA_PROMPT_INJECTED -->")
})
