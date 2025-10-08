import { expect, test } from "bun:test"

import {
  buildStreamEvents,
  buildToolCallFragments,
  createMockChatCompletions,
  createMockRateLimit,
} from "./_test-utils"

test("[Stream] handles complete tool call parameters in single chunk", async () => {
  await createMockChatCompletions(
    buildStreamEvents({
      toolCalls: [
        {
          name: "ReadFile",
          arguments: '{"absolute_path": "/path/to/file.txt"}',
        },
      ],
    }),
  )

  await createMockRateLimit()
  const { server } = await import("~/server?stream-complete-params")
  const res = await server.request(
    "/v1beta/models/gemini-pro:streamGenerateContent",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: "Read the file" }] }],
      }),
    },
  )

  expect(res.status).toBe(200)
  const body = await res.text()
  expect(
    body.includes(
      '"functionCall":{"name":"ReadFile","args":{"absolute_path":"/path/to/file.txt"}}',
    ),
  ).toBe(true)
})

test("[Stream] handles fragmented tool call parameters across multiple chunks", async () => {
  await createMockChatCompletions(
    buildToolCallFragments("ReadFile", { absolute_path: "/file.txt" }, 2),
  )

  await createMockRateLimit()
  const { server } = await import("~/server?stream-fragmented-params")
  const res = await server.request(
    "/v1beta/models/gemini-pro:streamGenerateContent",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: "Read the file" }] }],
      }),
    },
  )

  expect(res.status).toBe(200)
  const body = await res.text()
  expect(
    body.includes(
      '"functionCall":{"name":"ReadFile","args":{"absolute_path":"/file.txt"}}',
    ),
  ).toBe(true)
})

test("[Stream] correctly processes multiple concurrent tool calls", async () => {
  await createMockChatCompletions(
    buildStreamEvents({
      toolCalls: [
        { name: "ReadFile", arguments: '{"path": "/read.txt"}' },
        {
          name: "WriteFile",
          arguments: '{"path": "/write.txt", "content": "data"}',
          index: 1,
        },
      ],
    }),
  )

  await createMockRateLimit()
  const { server } = await import("~/server?stream-multiple-tools")
  const res = await server.request(
    "/v1beta/models/gemini-pro:streamGenerateContent",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: "Read and write files" }] }],
      }),
    },
  )

  expect(res.status).toBe(200)
  const body = await res.text()
  expect(
    body.includes(
      '"functionCall":{"name":"ReadFile","args":{"path":"/read.txt"}}',
    ),
  ).toBe(true)
  expect(
    body.includes(
      '"functionCall":{"name":"WriteFile","args":{"path":"/write.txt","content":"data"}}',
    ),
  ).toBe(true)
})
