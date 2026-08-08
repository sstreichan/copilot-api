import { afterEach, describe, expect, mock, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import {
  attachPremiumInfo,
  createHandlerLogger,
  debugJson,
  debugJsonAsync,
  debugJsonTail,
  formatStreamLog,
  getAttachedPremiumInfo,
  getPremiumInfoFromHeaders,
  shutdownLoggerRuntime,
} from "../src/lib/logger"
import {
  attachResponseHeaders,
  cloneForwardableResponseHeaders,
  getAttachedResponseHeaders,
} from "../src/lib/response-headers"
import { state } from "../src/lib/state"

const LOG_DIR_ENV = "COPILOT_API_LOG_DIR"
const originalLogDir = process.env[LOG_DIR_ENV]

afterEach(() => {
  state.verbose = false
  if (originalLogDir === undefined) {
    Reflect.deleteProperty(process.env, LOG_DIR_ENV)
  } else {
    process.env[LOG_DIR_ENV] = originalLogDir
  }
})

describe("getPremiumInfoFromHeaders", () => {
  test("derives remaining count from entitlement and percent remaining", () => {
    const headers = new Headers({
      "x-quota-snapshot-premium_interactions":
        "ent=1500&ov=0.0&ovPerm=false&rem=31.3&rst=2026-04-01T00%3A00%3A00Z",
    })

    expect(getPremiumInfoFromHeaders(headers)).toEqual({
      remaining: 469.5,
      total: 1500,
    })
  })

  test("returns null for unlimited or malformed premium quota snapshot", () => {
    expect(
      getPremiumInfoFromHeaders(
        new Headers({
          "x-quota-snapshot-premium_interactions":
            "ent=-1&ov=0.0&ovPerm=false&rem=100.0&rst=2026-04-01T00%3A00%3A00Z",
        }),
      ),
    ).toBeNull()

    expect(
      getPremiumInfoFromHeaders(
        new Headers({
          "x-quota-snapshot-premium_interactions": "ent=oops&rem=nope",
        }),
      ),
    ).toBeNull()
  })
})

describe("premium info attachment", () => {
  test("attaches and reads premium info on arbitrary objects", () => {
    const value = attachPremiumInfo(
      { ok: true },
      { remaining: 106.5, total: 300 },
    )
    expect(getAttachedPremiumInfo(value)).toEqual({
      remaining: 106.5,
      total: 300,
    })
  })
})

describe("response header attachment", () => {
  test("attaches and clones response headers on arbitrary objects", () => {
    const value = attachResponseHeaders(
      { ok: true },
      new Headers({
        "x-usage-ratelimit-session": "rem=5.7&rst=2026-04-21T06%3A35%3A37Z",
      }),
    )

    const attachedHeaders = getAttachedResponseHeaders(value)
    expect(attachedHeaders?.get("x-usage-ratelimit-session")).toBe(
      "rem=5.7&rst=2026-04-21T06%3A35%3A37Z",
    )

    attachedHeaders?.set("x-usage-ratelimit-session", "mutated")
    expect(
      getAttachedResponseHeaders(value)?.get("x-usage-ratelimit-session"),
    ).toBe("rem=5.7&rst=2026-04-21T06%3A35%3A37Z")
  })

  test("strips hop-by-hop headers while preserving forwardable quota headers", () => {
    const headers = cloneForwardableResponseHeaders(
      new Headers({
        connection: "keep-alive",
        "content-length": "123",
        "x-usage-ratelimit-session": "rem=5.7&rst=2026-04-21T06%3A35%3A37Z",
        "x-usage-ratelimit-weekly": "rem=74.9&rst=2026-04-27T00%3A00%3A00Z",
      }),
    )

    expect(headers.get("connection")).toBeNull()
    expect(headers.get("content-length")).toBeNull()
    expect(headers.get("x-usage-ratelimit-session")).toBe(
      "rem=5.7&rst=2026-04-21T06%3A35%3A37Z",
    )
    expect(headers.get("x-usage-ratelimit-weekly")).toBe(
      "rem=74.9&rst=2026-04-27T00%3A00%3A00Z",
    )
  })
})

describe("debugJsonAsync", () => {
  test("skips reading when verbose logging is disabled", async () => {
    state.verbose = false

    const logger = {
      debug: mock(() => {}),
    }
    const readValue = mock(() => Promise.resolve({ body: "request body" }))

    await debugJsonAsync(logger as never, "payload", readValue)

    expect(readValue).not.toHaveBeenCalled()
    expect(logger.debug).not.toHaveBeenCalled()
  })

  test("reads and logs when verbose logging is enabled", async () => {
    state.verbose = true

    const logger = {
      debug: mock(() => {}),
    }
    const payload = { body: "response body" }
    const readValue = mock(() => Promise.resolve(payload))

    await debugJsonAsync(logger as never, "payload", readValue)

    expect(readValue).toHaveBeenCalledTimes(1)
    expect(logger.debug).toHaveBeenCalledWith(
      "payload",
      JSON.stringify(payload),
    )
  })
})

describe("formatStreamLog", () => {
  test("suppresses in-progress stream output so each request logs once", () => {
    const log = formatStreamLog({
      model: "gpt-5-mini",
      chunks: 41,
      done: false,
    })

    expect(log).toBe("")
  })

  test("renders left badge with at most two decimal places", () => {
    const log = formatStreamLog({
      model: "gpt-5-mini",
      chunks: 42,
      done: true,
      premium: { remaining: 106.567, total: 300 },
    })

    expect(log).toContain("106.57")
    expect(log).not.toContain("106.567")
    expect(log).toContain("left")
  })
})

describe("debugJson", () => {
  test("skips serialization when verbose logging is disabled", () => {
    state.verbose = false

    const logger = {
      debug: mock(() => {}),
    }
    const toJSON = mock(() => ({ ok: true }))

    debugJson(logger as never, "payload", { toJSON })

    expect(toJSON).not.toHaveBeenCalled()
    expect(logger.debug).not.toHaveBeenCalled()
  })

  test("logs the serialized payload when verbose logging is enabled", () => {
    state.verbose = true

    const logger = {
      debug: mock(() => {}),
    }
    const payload = { ok: true }

    debugJson(logger as never, "payload", payload)

    expect(logger.debug).toHaveBeenCalledWith(
      "payload",
      JSON.stringify(payload),
    )
  })
})

describe("debugJsonTail", () => {
  test("preserves tail truncation behavior", () => {
    state.verbose = true

    const logger = {
      debug: mock(() => {}),
    }
    const payload = { text: "abcdefghijklmnopqrstuvwxyz" }
    const expected = JSON.stringify(payload).slice(-10)

    debugJsonTail(logger as never, "payload", {
      value: payload,
      tailLength: 10,
    })

    expect(logger.debug).toHaveBeenCalledWith("payload", expected)
  })
})

test("createHandlerLogger writes to COPILOT_API_LOG_DIR when set", async () => {
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-api-logs-"))
  process.env[LOG_DIR_ENV] = logDir

  try {
    const logger = createHandlerLogger("env-override-handler")
    for (let index = 0; index < 100; index += 1) {
      logger.error(`line-${index}`)
    }

    const dateKey = new Date().toLocaleDateString("sv-SE")
    const filePath = path.join(logDir, `env-override-handler-${dateKey}.log`)

    // Poll until the last line is flushed to disk: the log file is created
    // asynchronously by fs.createWriteStream, so it can exist while still
    // empty. Checking only for existence would race with the async write.
    let content = ""
    for (let attempt = 0; attempt < 50; attempt += 1) {
      if (fs.existsSync(filePath)) {
        content = fs.readFileSync(filePath, "utf8")
        if (content.includes("line-99")) {
          break
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 20))
    }

    expect(fs.existsSync(filePath)).toBe(true)
    expect(content).toContain("line-0")
    expect(content).toContain("line-99")
  } finally {
    // Close the write stream before deleting: Windows cannot remove a
    // directory while a file handle is still open. Retries cover the brief
    // window until the stream's fd is released after end().
    shutdownLoggerRuntime()
    fs.rmSync(logDir, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    })
  }
})
