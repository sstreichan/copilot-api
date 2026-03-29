import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"

describe("server logger middleware", () => {
  test("does not use unsafe any casts in logger wiring", () => {
    const source = readFileSync(
      new URL("../src/server.ts", import.meta.url),
      "utf8",
    )

    expect(source).not.toContain("as any")
    expect(source).toContain("const honoLogger: MiddlewareHandler = logger()")
    expect(source).toContain(
      "const loggerContext = c as Parameters<typeof honoLogger>[0]",
    )
    expect(source).toContain("return honoLogger(loggerContext, next)")
  })
})
