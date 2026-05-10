import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"

import type { AnthropicMessagesPayload } from "~/routes/messages/anthropic-types"
import type { ChatCompletionsPayload } from "~/services/copilot/create-chat-completions"
import type { ResponsesPayload } from "~/services/copilot/create-responses"

import { prewarmAutoSession } from "../src/lib/auto-session"
import { HTTPError } from "../src/lib/error"
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
  const fetchMock = mock((url: string, init?: RequestInit) => {
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

    if (
      url.includes("/v1/messages")
      || url.includes("/chat/completions")
      || url.includes("/responses")
    ) {
      const finalCalls = (
        globalThis as unknown as {
          __AUTO_SESSION_FINAL_CALLS__?: Array<[string, RequestInit]>
        }
      ).__AUTO_SESSION_FINAL_CALLS__
      finalCalls?.push([
        url,
        {
          ...init,
          headers: { ...(init?.headers as Record<string, string>) },
        },
      ])
      return Promise.resolve(finalResponseFactory())
    }

    return Promise.resolve(new Response("{}", { status: 200 }))
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

const getFinalCallSnapshots = (
  pathKeyword: string,
): Array<[string, RequestInit]> =>
  (
    (
      globalThis as unknown as {
        __AUTO_SESSION_FINAL_CALLS__?: Array<[string, RequestInit]>
      }
    ).__AUTO_SESSION_FINAL_CALLS__ ?? []
  ).filter(([url]) => url.includes(pathKeyword))

const createSelectorErrorResponse = () =>
  new Response("Invalid auto-mode selector\n", { status: 401 })

const createResponsesSuccess = (id: string) =>
  new Response(
    JSON.stringify({
      id,
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
  )

const createChatSuccess = (id: string) =>
  new Response(
    JSON.stringify({
      id,
      object: "chat.completion",
      choices: [],
    }),
    { status: 200 },
  )

const createMessagesSuccess = (id: string) =>
  new Response(JSON.stringify({ id }), { status: 200 })

beforeEach(() => {
  const queue: Array<ModelsSessionResponse> = []
  ;(
    globalThis as unknown as {
      __AUTO_SESSION_FINAL_CALLS__?: Array<[string, RequestInit]>
      __AUTO_SESSION_QUEUE__?: typeof queue
    }
  ).__AUTO_SESSION_QUEUE__ = queue
  ;(
    globalThis as unknown as {
      __AUTO_SESSION_FINAL_CALLS__?: Array<[string, RequestInit]>
    }
  ).__AUTO_SESSION_FINAL_CALLS__ = []

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

  test("responses chain invalidates stale auto-session and retries selector error once", async () => {
    ;(
      globalThis as unknown as {
        __AUTO_SESSION_QUEUE__: Array<ModelsSessionResponse>
      }
    ).__AUTO_SESSION_QUEUE__.push(
      queuedModelsSession(["gpt-5.3-codex"], "session-stale"),
      queuedModelsSession(["gpt-5.3-codex"], "session-fresh"),
    )

    let responseAttempt = 0
    wireFetchMock(() => {
      responseAttempt += 1
      if (responseAttempt === 1) {
        return createSelectorErrorResponse()
      }
      return createResponsesSuccess("resp-retried")
    })

    await prewarmAutoSession()
    const result = (await createResponses(createResponsesPayload, {
      vision: false,
      initiator: "user",
    })) as { id: string }

    const responseCalls = getFinalCallSnapshots("/responses")
    expect(responseCalls).toHaveLength(2)
    expect(getSessionHeader(responseCalls[0][1])).toBe("session-stale")
    expect(getSessionHeader(responseCalls[1][1])).toBe("session-fresh")
    expect(result.id).toBe("resp-retried")
  })

  test("responses chain does not retry selector error more than once", async () => {
    ;(
      globalThis as unknown as {
        __AUTO_SESSION_QUEUE__: Array<ModelsSessionResponse>
      }
    ).__AUTO_SESSION_QUEUE__.push(
      queuedModelsSession(["gpt-5.3-codex"], "session-stale"),
      queuedModelsSession(["gpt-5.3-codex"], "session-fresh"),
    )

    wireFetchMock(createSelectorErrorResponse)

    await prewarmAutoSession()
    try {
      await createResponses(createResponsesPayload, {
        vision: false,
        initiator: "user",
      })
      expect.unreachable("Expected selector error retry to fail")
    } catch (error) {
      expect(error).toBeInstanceOf(HTTPError)
    }

    const responseCalls = getFinalCallSnapshots("/responses")
    expect(responseCalls).toHaveLength(2)
    expect(getSessionHeader(responseCalls[0][1])).toBe("session-stale")
    expect(getSessionHeader(responseCalls[1][1])).toBe("session-fresh")
  })

  test("chat-completions chain invalidates stale auto-session and retries selector error once", async () => {
    ;(
      globalThis as unknown as {
        __AUTO_SESSION_QUEUE__: Array<ModelsSessionResponse>
      }
    ).__AUTO_SESSION_QUEUE__.push(
      queuedModelsSession(["gpt-5.3-codex"], "session-stale"),
      queuedModelsSession(["gpt-5.3-codex"], "session-fresh"),
    )

    let responseAttempt = 0
    wireFetchMock(() => {
      responseAttempt += 1
      if (responseAttempt === 1) {
        return createSelectorErrorResponse()
      }
      return createChatSuccess("chat-retried")
    })

    await prewarmAutoSession()
    const result = (await createChatCompletions(createChatPayload)) as {
      id: string
    }

    const chatCalls = getFinalCallSnapshots("/chat/completions")
    expect(chatCalls).toHaveLength(2)
    expect(getSessionHeader(chatCalls[0][1])).toBe("session-stale")
    expect(getSessionHeader(chatCalls[1][1])).toBe("session-fresh")
    expect(result.id).toBe("chat-retried")
  })

  test("messages chain invalidates stale auto-session and retries selector error once", async () => {
    ;(
      globalThis as unknown as {
        __AUTO_SESSION_QUEUE__: Array<ModelsSessionResponse>
      }
    ).__AUTO_SESSION_QUEUE__.push(
      queuedModelsSession(["gpt-5.3-codex"], "session-stale"),
      queuedModelsSession(["gpt-5.3-codex"], "session-fresh"),
    )

    let responseAttempt = 0
    wireFetchMock(() => {
      responseAttempt += 1
      if (responseAttempt === 1) {
        return createSelectorErrorResponse()
      }
      return createMessagesSuccess("msg-retried")
    })

    await prewarmAutoSession()
    const result = await createMessages(createMessagesPayload, {
      initiator: "user",
    })

    const messageCalls = getFinalCallSnapshots("/v1/messages")
    expect(messageCalls).toHaveLength(2)
    expect(getSessionHeader(messageCalls[0][1])).toBe("session-stale")
    expect(getSessionHeader(messageCalls[1][1])).toBe("session-fresh")
    const body = (await result.json()) as { id: string }
    expect(body.id).toBe("msg-retried")
  })
})
