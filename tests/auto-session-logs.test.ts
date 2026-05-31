import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test"
import consola from "consola"

import {
  getAutoSessionTokenForModel,
  invalidateAutoSession,
  prewarmAutoSession,
} from "../src/lib/auto-session"

type ModelsSessionResponse = {
  available_models: Array<string>
  expires_at: number
  session_token: string
}

const createResponse = (payload: ModelsSessionResponse) =>
  new Response(JSON.stringify(payload), { status: 200 })

beforeEach(() => {
  invalidateAutoSession()
  const queue: Array<ModelsSessionResponse> = []
  ;(
    globalThis as unknown as { __AUTO_SESSION_QUEUE__?: typeof queue }
  ).__AUTO_SESSION_QUEUE__ = queue

  const fetchMock = mock(() => {
    const currentQueue = (
      globalThis as unknown as {
        __AUTO_SESSION_QUEUE__?: Array<ModelsSessionResponse>
      }
    ).__AUTO_SESSION_QUEUE__

    if (!currentQueue || currentQueue.length === 0) {
      throw new Error("missing queued /models/session response")
    }

    const nextPayload = currentQueue.shift()
    if (!nextPayload) {
      throw new Error("missing queued /models/session response")
    }

    return Promise.resolve(createResponse(nextPayload))
  })

  // @ts-expect-error Bun mock is enough for runtime; typed fetch extras are not required in test
  ;(globalThis as { fetch: typeof fetch }).fetch = fetchMock
})

afterEach(() => {
  invalidateAutoSession()
  mock.restore()
})

describe("auto-session logging", () => {
  test("logs refreshed event via consola.info with existing style", async () => {
    ;(
      globalThis as unknown as {
        __AUTO_SESSION_QUEUE__: Array<ModelsSessionResponse>
      }
    ).__AUTO_SESSION_QUEUE__.push({
      available_models: ["gpt-5.3-codex", "gpt-5.4"],
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      session_token: "token-initial",
    })

    const infoSpy = spyOn(consola, "info")

    await prewarmAutoSession()

    expect(infoSpy).toHaveBeenCalled()
    expect(infoSpy).toHaveBeenCalledWith(
      "[auto-session] refreshed token, models=2",
    )
  })

  test("logs hit event via consola.info when model is covered", async () => {
    ;(
      globalThis as unknown as {
        __AUTO_SESSION_QUEUE__: Array<ModelsSessionResponse>
      }
    ).__AUTO_SESSION_QUEUE__.push({
      available_models: ["gpt-5.3-codex"],
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      session_token: "token-initial",
    })

    const infoSpy = spyOn(consola, "info")

    await prewarmAutoSession()
    await getAutoSessionTokenForModel("gpt-5.3-codex")

    expect(infoSpy).toHaveBeenCalledWith(
      "[auto-session] hit model=gpt-5.3-codex",
    )
  })

  test("logs miss event via consola.info when model is not covered", async () => {
    ;(
      globalThis as unknown as {
        __AUTO_SESSION_QUEUE__: Array<ModelsSessionResponse>
      }
    ).__AUTO_SESSION_QUEUE__.push({
      available_models: ["gpt-5.3-codex"],
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      session_token: "token-initial",
    })

    const infoSpy = spyOn(consola, "info")

    await prewarmAutoSession()
    await getAutoSessionTokenForModel("not-covered")

    expect(infoSpy).toHaveBeenCalledWith(
      "[auto-session] miss model=not-covered",
    )
  })
})
