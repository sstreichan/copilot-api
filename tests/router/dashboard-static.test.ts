import { describe, expect, test } from "bun:test"

import {
  createDashboardHandler,
  createStickyRouterState,
} from "../../router/state"
import type { DashboardStaticFile, StickyRouterState } from "../../router/state"

function createState() {
  return createStickyRouterState([
    { name: "alpha", port: 4141 },
    { name: "bravo", port: 4142 },
  ])
}

const dashboardFile = Bun.file(
  new URL("../../router/dashboard.html", import.meta.url),
)

const v2Files = [
  {
    path: "/v2",
    file: Bun.file(new URL("../../router/dashboard-v2.html", import.meta.url)),
    contentType: "text/html; charset=utf-8",
  },
  {
    path: "/v2/dashboard-v2.css",
    file: Bun.file(new URL("../../router/dashboard-v2.css", import.meta.url)),
    contentType: "text/css; charset=utf-8",
  },
  {
    path: "/v2/dashboard-v2.js",
    file: Bun.file(new URL("../../router/dashboard-v2.js", import.meta.url)),
    contentType: "text/javascript; charset=utf-8",
  },
] as const

function makeHandler(
  state: StickyRouterState,
  staticFiles?: ReadonlyArray<DashboardStaticFile>,
) {
  return createDashboardHandler({
    state,
    logger: () => {},
    dashboardFile,
    staticFiles,
  })
}

describe("dashboard staticFiles", () => {
  test("serves v2 html, css, and js with correct content types", async () => {
    const handler = makeHandler(createState(), v2Files)

    const html = await handler(new Request("http://localhost/v2"))
    expect(html.status).toBe(200)
    expect(html.headers.get("content-type")).toBe("text/html; charset=utf-8")
    const htmlText = await html.text()
    expect(htmlText).toContain("/v2/dashboard-v2.css")
    expect(htmlText).toContain("/v2/dashboard-v2.js")

    const css = await handler(
      new Request("http://localhost/v2/dashboard-v2.css"),
    )
    expect(css.status).toBe(200)
    expect(css.headers.get("content-type")).toBe("text/css; charset=utf-8")
    expect(await css.text()).toContain(".hero-bar-fill")

    const js = await handler(new Request("http://localhost/v2/dashboard-v2.js"))
    expect(js.status).toBe(200)
    expect(js.headers.get("content-type")).toBe(
      "text/javascript; charset=utf-8",
    )
    expect(await js.text()).toContain("connectSse")
  })

  test("unknown static path still falls through to 404", async () => {
    const handler = makeHandler(createState(), v2Files)
    const response = await handler(new Request("http://localhost/v2/nope.css"))
    expect(response.status).toBe(404)
  })

  test("missing static file returns 404", async () => {
    const handler = makeHandler(createState(), [
      {
        path: "/v2/missing.html",
        file: Bun.file(
          `/tmp/sticky-router-missing-${crypto.randomUUID()}.html`,
        ),
        contentType: "text/html; charset=utf-8",
      },
    ])
    const response = await handler(
      new Request("http://localhost/v2/missing.html"),
    )
    expect(response.status).toBe(404)
  })

  test("non-GET request to a static path is not served", async () => {
    const handler = makeHandler(createState(), v2Files)
    const response = await handler(
      new Request("http://localhost/v2", { method: "POST" }),
    )
    expect(response.status).toBe(404)
  })

  test("without staticFiles option, /v2 is 404 and / stays intact", async () => {
    const handler = makeHandler(createState())
    const v2 = await handler(new Request("http://localhost/v2"))
    expect(v2.status).toBe(404)
    const root = await handler(new Request("http://localhost/"))
    expect(root.status).toBe(200)
  })
})
