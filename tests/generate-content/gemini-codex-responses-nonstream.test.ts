import { expect, test, mock } from "bun:test"

import type {
  ResponsesPayload,
  ResponsesResult,
} from "~/services/copilot/create-responses"

import { makeRequest, createMockRateLimit } from "./_test-utils"

// Phase 1 test: non-streaming codex model should route through Responses API
// and return translated Gemini response while preserving system injection marker.

test("codex non-stream request uses Responses API path", async () => {
  await createMockRateLimit()
  let capturedResponsesPayload: ResponsesPayload | undefined

  await mock.module("~/services/copilot/create-responses", () => ({
    createResponses: (payload: ResponsesPayload) => {
      capturedResponsesPayload = payload
      const result: ResponsesResult = {
        id: "resp-id",
        object: "response",
        created_at: Date.now(),
        model: payload.model,
        output: [
          {
            id: "out-1",
            type: "message",
            role: "assistant",
            status: "completed",
            content: [
              {
                type: "output_text",
                text: "Hello from codex responses",
                annotations: [],
              },
            ],
          },
        ],
        output_text: "Hello from codex responses",
        status: "completed",
        usage: {
          input_tokens: 50,
          output_tokens: 20,
          total_tokens: 70,
          input_tokens_details: { cached_tokens: 0 },
        },
        error: null,
        incomplete_details: null,
        instructions: payload.instructions ?? null,
        metadata: null,
        parallel_tool_calls: true,
        temperature: payload.temperature ?? null,
        tool_choice: payload.tool_choice ?? "auto",
        tools: payload.tools ?? [],
        top_p: payload.top_p ?? null,
      }
      return result
    },
  }))

  // Do NOT mock create-chat-completions intentionally to ensure we don't hit that path

  const response = await makeRequest(
    "/v1beta/models/gemini-2.5-codex:generateContent",
    {
      systemInstruction: {
        parts: [{ text: "System baseline" }],
      },
      contents: [{ role: "user", parts: [{ text: "Say hi" }] }],
    },
  )

  expect(response.status).toBe(200)
  const json: unknown = await response.json()
  if (!json || typeof json !== "object")
    throw new Error("invalid json response")
  const out = json as {
    candidates?: Array<{ content: { parts: Array<unknown> } }>
  }

  // Basic shape expectations
  expect(out).toHaveProperty("candidates")
  expect(Array.isArray(out.candidates)).toBe(true)
  const firstCandidate = out.candidates?.[0]
  expect(firstCandidate).toBeDefined()
  const hasText = firstCandidate?.content.parts.some(
    (p) =>
      Boolean(p)
      && typeof p === "object"
      && "text" in (p as { text?: unknown }),
  )
  expect(hasText).toBe(true)

  // Ensure mapping occurred: internal payload should have provider model name
  expect(capturedResponsesPayload).toBeDefined()
  if (!capturedResponsesPayload) throw new Error("responses payload missing")
  expect(capturedResponsesPayload.model).toBe("gpt-5-codex")

  // System instruction injection marker should be present (added in translation layer)
  if (capturedResponsesPayload.instructions) {
    expect(capturedResponsesPayload.instructions).toMatch(
      /<!-- CODEX_EXTRA_PROMPT_INJECTED -->/,
    )
  } else {
    throw new Error("instructions missing for codex responses path")
  }
})
