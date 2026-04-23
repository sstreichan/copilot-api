import { beforeEach, describe, expect, mock, test } from "bun:test"

import { HTTPError } from "../src/lib/error"
import { state } from "../src/lib/state"
import { getModelsSession } from "../src/services/copilot/get-models-session"

describe("getModelsSession", () => {
  beforeEach(() => {
    state.copilotToken = "test-copilot-token"
    state.accountType = "individual"
  })

  test("POSTs /models/session with json body and content-type", async () => {
    const fetchMock = mock(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            available_models: ["gpt-5.3-codex"],
            expires_at: 2_200_000_000,
            session_token: "session-1",
            discounted_costs: { auto: 0.5 },
          }),
          { status: 200 },
        ),
      ),
    )
    // @ts-expect-error Bun mock is enough for runtime; typed fetch extras are not required in test
    ;(globalThis as { fetch: typeof fetch }).fetch = fetchMock

    const result = await getModelsSession()

    expect(result.session_token).toBe("session-1")
    expect(result.available_models).toEqual(["gpt-5.3-codex"])

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const firstCall = fetchMock.mock.calls[0]
    expect(firstCall).toBeDefined()
    const [url, init] = firstCall as unknown as [
      string,
      RequestInit & { headers: Record<string, string> },
    ]
    expect(url).toContain("/models/session")
    expect(init.method).toBe("POST")
    expect(init.body).toBe(
      JSON.stringify({ auto_mode: { model_hints: ["auto"] } }),
    )
    expect(init.headers["content-type"]).toBe("application/json")
  })

  test("throws HTTPError when upstream /models/session fails", () => {
    const fetchMock = mock(() =>
      Promise.resolve(
        new Response(JSON.stringify({ error: "bad gateway" }), { status: 502 }),
      ),
    )
    // @ts-expect-error Bun mock is enough for runtime; typed fetch extras are not required in test
    ;(globalThis as { fetch: typeof fetch }).fetch = fetchMock

    const promise = getModelsSession()
    expect(promise).rejects.toBeInstanceOf(HTTPError)
  })
})
