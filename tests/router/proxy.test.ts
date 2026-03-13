import { describe, expect, test } from "bun:test"

import {
  createStickyRouterState,
  discoverModels,
  proxyTo,
} from "../../router/state"

function createFetchStub(
  handler: (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ) => Promise<Response>,
): typeof fetch {
  return Object.assign(handler, { preconnect: fetch.preconnect })
}

function toInputUrl(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === "string") {
    return input
  }

  if (input instanceof URL) {
    return input.toString()
  }

  return input.url
}

function createState() {
  return createStickyRouterState([
    { name: "alpha", port: 4141 },
    { name: "beta", port: 4142 },
  ])
}

describe("router I/O helpers", () => {
  test("discoverModels populates model maps and logs failures", async () => {
    const state = createState()
    const logs: Array<string> = []
    const fetchImpl = createFetchStub((input) => {
      const url = toInputUrl(input)

      if (url.includes(":4141/")) {
        return Promise.resolve(
          Response.json({
            data: [{ id: "gpt-4.1" }, { id: "claude-3.7" }],
          }),
        )
      }

      return Promise.reject(new Error("offline"))
    })

    await discoverModels(state, (line) => logs.push(line), fetchImpl)

    expect(state.portToModels.get(4141)).toEqual(["gpt-4.1", "claude-3.7"])
    expect(state.portToModels.has(4142)).toBe(false)
    expect(state.modelToPorts.get("gpt-4.1")).toEqual([4141])
    expect(state.modelToPorts.get("claude-3.7")).toEqual([4141])
    expect(
      logs.some((line) => line.includes("FAILED to discover beta:4142")),
    ).toBe(true)
    expect(logs.at(-1)).toBe("total: 2 unique models across 1 instances")
  })

  test("proxyTo forwards request metadata and returns upstream response", async () => {
    const logs: Array<string> = []
    let targetUrl = ""
    let method = ""
    let forwardedBody = ""
    let forwardedHost: string | null = "unknown"

    const fetchImpl = createFetchStub((input, init) => {
      targetUrl = toInputUrl(input)
      method = init?.method ?? "GET"
      forwardedBody = typeof init?.body === "string" ? init.body : ""
      forwardedHost = new Headers(init?.headers).get("host")

      return Promise.resolve(
        new Response("upstream-ok", {
          status: 201,
          headers: { "x-upstream": "1" },
        }),
      )
    })

    const req = new Request("http://router.local/v1/messages?debug=1", {
      method: "POST",
      headers: {
        host: "router.local",
        "content-type": "application/json",
      },
      body: '{"model":"gpt-4.1"}',
    })

    const res = await proxyTo({
      port: 4141,
      context: {
        body: '{"model":"gpt-4.1"}',
        req,
        url: new URL(req.url),
      },
      logger: (line) => logs.push(line),
      fetchImpl,
    })

    expect(targetUrl).toBe("http://localhost:4141/v1/messages?debug=1")
    expect(method).toBe("POST")
    expect(forwardedBody).toBe('{"model":"gpt-4.1"}')
    expect(forwardedHost).toBeNull()
    expect(logs).toEqual([])
    expect(res.status).toBe(201)
    expect(res.headers.get("x-upstream")).toBe("1")
    expect(await res.text()).toBe("upstream-ok")
  })

  test("proxyTo returns 502 JSON when the upstream fetch fails", async () => {
    const logs: Array<string> = []
    const fetchImpl = createFetchStub(
      () =>
        new Promise<Response>((_, reject) => {
          reject(new Error("connect ECONNREFUSED"))
        }),
    )

    const req = new Request("http://router.local/v1/messages", {
      method: "POST",
      body: '{"model":"gpt-4.1"}',
    })

    const res = await proxyTo({
      port: 4141,
      context: {
        body: '{"model":"gpt-4.1"}',
        req,
        url: new URL(req.url),
      },
      logger: (line) => logs.push(line),
      fetchImpl,
    })

    expect(res.status).toBe(502)
    expect(await res.json()).toEqual({
      error: "upstream connection failed on port 4141",
    })
    expect(logs).toEqual(["PROXY ERROR → :4141: connect ECONNREFUSED"])
  })
})
