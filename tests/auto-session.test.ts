import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"

import { state } from "../src/lib/state"

type AutoSessionModule = typeof import("../src/lib/auto-session")

type ModelsSessionResponse = {
  available_models: Array<string>
  expires_at: number
  session_token: string
  discounted_costs?: Record<string, number>
}

type TestGlobal = typeof globalThis & {
  __AUTO_SESSION_QUEUE__?: Array<ModelsSessionResponse>
  fetch: typeof fetch
}

const createResponse = (payload: ModelsSessionResponse) =>
  new Response(JSON.stringify(payload), { status: 200 })

const getQueue = (): Array<ModelsSessionResponse> => {
  const queue = (globalThis as TestGlobal).__AUTO_SESSION_QUEUE__
  if (!queue) {
    throw new Error("missing auto session queue")
  }
  return queue
}

const setFetchMock = (mockedFetch: typeof fetch): void => {
  ;(globalThis as TestGlobal).fetch = mockedFetch
}

const loadAutoSessionModule = async (): Promise<AutoSessionModule> => {
  const module = (await import(
    `../src/lib/auto-session?test=${Date.now()}-${Math.random()}`
  )) as AutoSessionModule
  return module
}

let fetchMock: ReturnType<typeof mock>

describe("auto-session", () => {
  beforeEach(() => {
    const queue: Array<ModelsSessionResponse> = []
    ;(globalThis as TestGlobal).__AUTO_SESSION_QUEUE__ = queue
    state.copilotToken = "dummy-auth-token-a"

    fetchMock = mock(() => {
      const currentQueue = getQueue()
      if (currentQueue.length === 0) {
        throw new Error("missing queued /models/session response")
      }
      const nextPayload = currentQueue.shift()
      if (!nextPayload) {
        throw new Error("missing queued /models/session response")
      }
      return Promise.resolve(createResponse(nextPayload))
    })
    setFetchMock(fetchMock as unknown as typeof fetch)
  })

  afterEach(() => {
    mock.restore()
  })

  test("prewarm caches available models and token", async () => {
    const {
      getAutoSessionTokenForModel,
      isModelAutoCovered,
      prewarmAutoSession,
    } = await loadAutoSessionModule()

    getQueue().push({
      available_models: ["gpt-5.3-codex", "gpt-5.4"],
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      session_token: "token-initial",
    })

    await prewarmAutoSession()

    expect(isModelAutoCovered("gpt-5.3-codex")).toBe(true)
    expect(isModelAutoCovered("not-covered")).toBe(false)

    const token = await getAutoSessionTokenForModel("gpt-5.4")
    expect(token).toBe("token-initial")
  })

  test("returns undefined when model is not covered", async () => {
    const { getAutoSessionTokenForModel, prewarmAutoSession } =
      await loadAutoSessionModule()

    getQueue().push({
      available_models: ["gpt-5.3-codex"],
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      session_token: "token-initial",
    })

    await prewarmAutoSession()

    const token = await getAutoSessionTokenForModel("gpt-4o")
    expect(token).toBeUndefined()
  })

  test("refreshes on first covered request when token missing", async () => {
    const { getAutoSessionTokenForModel, prewarmAutoSession } =
      await loadAutoSessionModule()

    getQueue().push(
      {
        available_models: ["gpt-5.3-codex"],
        expires_at: Math.floor(Date.now() / 1000) + 3600,
        session_token: "",
      },
      {
        available_models: ["gpt-5.3-codex"],
        expires_at: Math.floor(Date.now() / 1000) + 3600,
        session_token: "token-refreshed",
      },
    )

    await prewarmAutoSession()
    const token = await getAutoSessionTokenForModel("gpt-5.3-codex")
    expect(token).toBe("token-refreshed")
  })

  test("refreshes before first covered request when prewarmed token is near expiry", async () => {
    const { getAutoSessionTokenForModel, prewarmAutoSession } =
      await loadAutoSessionModule()

    getQueue().push(
      {
        available_models: ["gpt-5.3-codex"],
        expires_at: Math.floor((Date.now() + 4 * 60 * 1000) / 1000),
        session_token: "token-near-expiry",
      },
      {
        available_models: ["gpt-5.3-codex"],
        expires_at: Math.floor(Date.now() / 1000) + 3600,
        session_token: "token-refreshed",
      },
    )

    await prewarmAutoSession()

    const first = await getAutoSessionTokenForModel("gpt-5.3-codex")
    expect(first).toBe("token-refreshed")

    const second = await getAutoSessionTokenForModel("gpt-5.3-codex")
    expect(second).toBe("token-refreshed")
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  test("refreshes cached session when Copilot auth token identity changes", async () => {
    const { getAutoSessionTokenForModel, prewarmAutoSession } =
      await loadAutoSessionModule()

    getQueue().push(
      {
        available_models: ["gpt-5.3-codex"],
        expires_at: Math.floor(Date.now() / 1000) + 3600,
        session_token: "session-for-auth-a",
      },
      {
        available_models: ["gpt-5.3-codex"],
        expires_at: Math.floor(Date.now() / 1000) + 3600,
        session_token: "session-for-auth-b",
      },
    )

    await prewarmAutoSession()
    const first = await getAutoSessionTokenForModel("gpt-5.3-codex")
    expect(first).toBe("session-for-auth-a")

    state.copilotToken = "dummy-auth-token-b"

    const second = await getAutoSessionTokenForModel("gpt-5.3-codex")
    expect(second).toBe("session-for-auth-b")
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  test("reuses cached token for covered model without extra refresh", async () => {
    const { getAutoSessionTokenForModel, prewarmAutoSession } =
      await loadAutoSessionModule()

    getQueue().push({
      available_models: ["gpt-5.3-codex"],
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      session_token: "token-stable",
    })

    await prewarmAutoSession()

    const first = await getAutoSessionTokenForModel("gpt-5.3-codex")
    const second = await getAutoSessionTokenForModel("gpt-5.3-codex")

    expect(first).toBe("token-stable")
    expect(second).toBe("token-stable")
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  test("prewarm failure is swallowed and does not block subsequent flow", async () => {
    const { getAutoSessionTokenForModel, prewarmAutoSession } =
      await loadAutoSessionModule()

    const queue = getQueue()

    let shouldRejectPrewarm = true
    const rejectedFetch = mock(() => {
      if (shouldRejectPrewarm) {
        shouldRejectPrewarm = false
        return Promise.reject(new Error("prewarm failed"))
      }

      const nextPayload = queue.shift()
      if (!nextPayload) {
        throw new Error("missing queued /models/session response")
      }
      return Promise.resolve(createResponse(nextPayload))
    })
    setFetchMock(rejectedFetch as unknown as typeof fetch)

    queue.push({
      available_models: ["gpt-5.3-codex"],
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      session_token: "token-after-prewarm-failure",
    })

    await prewarmAutoSession()
    const token = await getAutoSessionTokenForModel(
      "definitely-not-covered-model",
    )
    expect(token).toBeUndefined()
    expect(rejectedFetch).toHaveBeenCalledTimes(2)
  })

  test("refreshes on first covered request after prewarm failure with empty cache", async () => {
    const { getAutoSessionTokenForModel, prewarmAutoSession } =
      await loadAutoSessionModule()

    const queue = getQueue()

    let shouldRejectPrewarm = true
    fetchMock = mock(() => {
      if (shouldRejectPrewarm) {
        shouldRejectPrewarm = false
        return Promise.reject(new Error("prewarm failed"))
      }

      const nextPayload = queue.shift()
      if (!nextPayload) {
        throw new Error("missing queued /models/session response")
      }
      return Promise.resolve(createResponse(nextPayload))
    })
    setFetchMock(fetchMock as unknown as typeof fetch)

    queue.push({
      available_models: ["gpt-5.3-codex"],
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      session_token: "token-refreshed-after-prewarm-failure",
    })

    await prewarmAutoSession()

    const first = await getAutoSessionTokenForModel("gpt-5.3-codex")
    const second = await getAutoSessionTokenForModel("gpt-5.3-codex")

    expect(first).toBe("token-refreshed-after-prewarm-failure")
    expect(second).toBe("token-refreshed-after-prewarm-failure")
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})
