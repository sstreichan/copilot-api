import { expect, test, mock } from "bun:test"

import type { CapturedPayload } from "./test-types"

import { makeRequest, createMockRateLimit } from "./_test-utils"

test("injects extra prompt to existing system instruction for gpt-5-codex", async () => {
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

  const response = await makeRequest(
    "/v1beta/models/gemini-2.5-codex:generateContent",
    {
      systemInstruction: {
        parts: [{ text: "You are a helpful coding assistant." }],
      },
      contents: [{ role: "user", parts: [{ text: "Write a function" }] }],
    },
  )

  expect(response.status).toBe(200)

  // Verify model mapping
  expect(capturedPayload.model).toBe("gpt-5-codex")

  // Responses API uses instructions field instead of messages
  expect(capturedPayload.instructions).toBeDefined()
  const instructions = capturedPayload.instructions as string

  // Verify original instruction is preserved
  expect(instructions).toContain("You are a helpful coding assistant.")

  // Verify extra prompt was injected
  expect(instructions).toContain("## Tool use")
  expect(instructions).toContain("### Bash tool")

  // Verify marker is present (prevents duplicate injection)
  expect(instructions).toContain("<!-- CODEX_EXTRA_PROMPT_INJECTED -->")
})

test("creates system message with extra prompt when no systemInstruction exists", async () => {
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

  const response = await makeRequest(
    "/v1beta/models/gemini-2.5-codex:generateContent",
    {
      contents: [{ role: "user", parts: [{ text: "Hello" }] }],
    },
  )

  expect(response.status).toBe(200)

  // Verify instructions field was created with extra prompt
  expect(capturedPayload.instructions).toBeDefined()
  const instructions = capturedPayload.instructions as string

  // Verify extra prompt is present
  expect(instructions).toContain("## Tool use")
  expect(instructions).toContain("<!-- CODEX_EXTRA_PROMPT_INJECTED -->")
})
