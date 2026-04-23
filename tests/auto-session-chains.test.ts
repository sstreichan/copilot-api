import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"

import type { AnthropicMessagesPayload } from "~/routes/messages/anthropic-types"
import type { ChatCompletionsPayload } from "~/services/copilot/create-chat-completions"
import type { ResponsesPayload } from "~/services/copilot/create-responses"

import { prewarmAutoSession } from "../src/lib/auto-session"
import { state } from "../src/lib/state"
import { createChatCompletions } from "../src/services/copilot/create-chat-completions"
import { createMessages } from "../src/services/copilot/create-messages"
import { createResponses } from "../src/services/copilot/create-responses"

type ModelsSessionResponse = {
  available_models: Array<string>
  expires_at: number
  session_token: string
}

const createMessagesPayload: AnthropicMessagesPayload = {
  model: "gpt-5.3-codex",
  max_tokens: 256,
  messages: [{ role: "user", content: "hello" }],
}

const createChatPayload: ChatCompletionsPayload = {
  model: "gpt-5.3-codex",
  messages: [{ role: "user", content: "hello" }],
}

const createResponsesPayload: ResponsesPayload = {
  model: "gpt-5.3-codex",
  input: [{ role: "user", content: "hello" }],
}

const createModelsSessionResponse = (payload: ModelsSessionResponse) =>
  new Response(JSON.stringify(payload), { status: 200 })

const queuedModelsSession = (
  availableModels: Array<string>,
  sessionToken: string,
): ModelsSessionResponse => ({
  available_models: availableModels,
  expires_at: Math.floor(Date.now() / 1000) + 3600,
  session_token: sessionToken,
})

const wireFetchMock = (
  finalResponseFactory: () => Response,
): ReturnType<typeof mock> => {
  const fetchMock = mock((url: string) => {
    if (url.includes("/models/session")) {
      const currentQueue = (
        globalThis as unknown as {
          __AUTO_SESSION_QUEUE__?: Array<ModelsSessionResponse>
        }
      ).__AUTO_SESSION_QUEUE__
      const nextPayload = currentQueue?.shift()
      if (!nextPayload)
        throw new Error("missing queued /models/session response")
      return Promise.resolve(createModelsSessionResponse(nextPayload))
    }

    return Promise.resolve(finalResponseFactory())
  })

  // @ts-expect-error Bun mock is enough for runtime; typed fetch extras are not required in test
  ;(globalThis as { fetch: typeof fetch }).fetch = fetchMock
  return fetchMock
}

const findCall = (
  fetchMock: ReturnType<typeof mock>,
  pathKeyword: string,
): [string, RequestInit] => {
  const matchedCall = fetchMock.mock.calls.find((call) =>
    (call[0] as string).includes(pathKeyword),
  )
  expect(matchedCall).toBeDefined()
  return matchedCall as [string, RequestInit]
}

const getSessionHeader = (init: RequestInit): string | undefined => {
  const headers = init.headers as Record<string, string>
  return headers["Copilot-Session-Token"]
}

beforeEach(() => {
  const queue: Array<ModelsSessionResponse> = []
  ;(
    globalThis as unknown as { __AUTO_SESSION_QUEUE__?: typeof queue }
  ).__AUTO_SESSION_QUEUE__ = queue

  state.copilotToken = "test-copilot-token"
  state.vsCodeVersion = "1.0.0"
  state.accountType = "individual"
  state.forceAgent = false
  state.models = undefined
  state.interactionId = "test-interaction-id"
})

afterEach(() => {
  mock.restore()
})

describe("auto-session token injection across chains", () => {
  test("messages chain adds Copilot-Session-Token when model is covered", async () => {
    ;(
      globalThis as unknown as {
        __AUTO_SESSION_QUEUE__: Array<ModelsSessionResponse>
      }
    ).__AUTO_SESSION_QUEUE__.push(
      queuedModelsSession(["gpt-5.3-codex"], "session-hit"),
    )

    const fetchMock = wireFetchMock(
      () => new Response(JSON.stringify({ id: "msg-1" }), { status: 200 }),
    )

    await prewarmAutoSession()
    await createMessages(createMessagesPayload, { initiator: "user" })

    const [, init] = findCall(fetchMock, "/v1/messages")
    expect(getSessionHeader(init)).toBe("session-hit")
  })

  test("messages chain keeps old path when model is not covered", async () => {
    ;(
      globalThis as unknown as {
        __AUTO_SESSION_QUEUE__: Array<ModelsSessionResponse>
      }
    ).__AUTO_SESSION_QUEUE__.push(
      queuedModelsSession(["other-model"], "session-miss"),
    )

    const fetchMock = wireFetchMock(
      () => new Response(JSON.stringify({ id: "msg-2" }), { status: 200 }),
    )

    await prewarmAutoSession()
    await createMessages(createMessagesPayload, { initiator: "user" })

    const [, init] = findCall(fetchMock, "/v1/messages")
    const headers = init.headers as Record<string, string>
    expect(getSessionHeader(init)).toBeUndefined()
    expect(headers["x-initiator"]).toBe("user")
  })

  test("chat-completions chain adds Copilot-Session-Token when model is covered", async () => {
    ;(
      globalThis as unknown as {
        __AUTO_SESSION_QUEUE__: Array<ModelsSessionResponse>
      }
    ).__AUTO_SESSION_QUEUE__.push(
      queuedModelsSession(["gpt-5.3-codex"], "session-hit"),
    )

    const fetchMock = wireFetchMock(
      () =>
        new Response(
          JSON.stringify({
            id: "chat-1",
            object: "chat.completion",
            choices: [],
          }),
          { status: 200 },
        ),
    )

    await prewarmAutoSession()
    await createChatCompletions(createChatPayload)

    const [, init] = findCall(fetchMock, "/chat/completions")
    expect(getSessionHeader(init)).toBe("session-hit")
  })

  test("chat-completions chain keeps old path when model is not covered", async () => {
    ;(
      globalThis as unknown as {
        __AUTO_SESSION_QUEUE__: Array<ModelsSessionResponse>
      }
    ).__AUTO_SESSION_QUEUE__.push(
      queuedModelsSession(["other-model"], "session-miss"),
    )

    const fetchMock = wireFetchMock(
      () =>
        new Response(
          JSON.stringify({
            id: "chat-2",
            object: "chat.completion",
            choices: [],
          }),
          { status: 200 },
        ),
    )

    await prewarmAutoSession()
    const result = (await createChatCompletions(createChatPayload)) as {
      id: string
    }

    const [, init] = findCall(fetchMock, "/chat/completions")
    expect(getSessionHeader(init)).toBeUndefined()
    expect(result.id).toBe("chat-2")
  })

  test("responses chain adds Copilot-Session-Token when model is covered", async () => {
    ;(
      globalThis as unknown as {
        __AUTO_SESSION_QUEUE__: Array<ModelsSessionResponse>
      }
    ).__AUTO_SESSION_QUEUE__.push(
      queuedModelsSession(["gpt-5.3-codex"], "session-hit"),
    )

    const fetchMock = wireFetchMock(
      () =>
        new Response(
          JSON.stringify({
            id: "resp-1",
            object: "response",
            created_at: Date.now(),
            model: "gpt-5.3-codex",
            output: [],
            output_text: "",
            status: "completed",
            usage: null,
            error: null,
            incomplete_details: null,
            instructions: null,
            metadata: null,
            parallel_tool_calls: false,
            temperature: null,
            tool_choice: null,
            tools: [],
            top_p: null,
          }),
          { status: 200 },
        ),
    )

    await prewarmAutoSession()
    await createResponses(createResponsesPayload, {
      vision: false,
      initiator: "user",
    })

    const [, init] = findCall(fetchMock, "/responses")
    expect(getSessionHeader(init)).toBe("session-hit")
  })

  test("responses chain keeps old path when model is not covered", async () => {
    ;(
      globalThis as unknown as {
        __AUTO_SESSION_QUEUE__: Array<ModelsSessionResponse>
      }
    ).__AUTO_SESSION_QUEUE__.push(
      queuedModelsSession(["other-model"], "session-miss"),
    )

    const fetchMock = wireFetchMock(
      () =>
        new Response(
          JSON.stringify({
            id: "resp-2",
            object: "response",
            created_at: Date.now(),
            model: "gpt-5.3-codex",
            output: [],
            output_text: "",
            status: "completed",
            usage: null,
            error: null,
            incomplete_details: null,
            instructions: null,
            metadata: null,
            parallel_tool_calls: false,
            temperature: null,
            tool_choice: null,
            tools: [],
            top_p: null,
          }),
          { status: 200 },
        ),
    )

    await prewarmAutoSession()
    const result = (await createResponses(createResponsesPayload, {
      vision: false,
      initiator: "user",
    })) as { id: string }

    const [, init] = findCall(fetchMock, "/responses")
    expect(getSessionHeader(init)).toBeUndefined()
    expect(result.id).toBe("resp-2")
  })
})
