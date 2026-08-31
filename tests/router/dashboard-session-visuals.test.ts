import { describe, expect, test } from "bun:test"
import { Script, createContext } from "node:vm"

const dashboardPath = new URL("../../router/dashboard.html", import.meta.url)

function extractFunction(script: string, name: string): string {
  const start = script.indexOf(`function ${name}(`)
  if (start === -1) throw new TypeError(`${name} missing`)
  const bodyStart = script.indexOf("{", start)
  let depth = 0
  for (let index = bodyStart; index < script.length; index += 1) {
    if (script[index] === "{") depth += 1
    if (script[index] === "}") depth -= 1
    if (depth === 0) return script.slice(start, index + 1)
  }
  throw new TypeError(`${name} body incomplete`)
}

describe("route history session visuals", () => {
  test("keeps the timeline while adding stable session colors and filtering", async () => {
    const html = await Bun.file(dashboardPath).text()

    expect(html).toContain('id="history-session-filters"')
    expect(html).toContain("sessionColor")
    expect(html).toContain("session-badge")
    expect(html).toContain("session-filter")
    expect(html).toContain("history-session-muted")
    expect(html).toContain("activeSession")
    expect(html).toContain("title=\"${escapeHtml(item.sid || '-')}\"")
    expect(html).not.toContain("sessionShortName")

    const sessionColorSource = extractFunction(html, "sessionColor")
    const sessionColorSandbox: {
      sessionColor?: (session: string) => string
    } = {}
    new Script(
      `${sessionColorSource}; globalThis.sessionColor = sessionColor`,
    ).runInContext(createContext(sessionColorSandbox))
    const sessionColor = sessionColorSandbox.sessionColor
    if (!sessionColor) throw new TypeError("sessionColor unavailable")

    expect(sessionColor("session-a")).toBe(sessionColor("session-a"))
    expect(sessionColor("session-a")).not.toBe(sessionColor("session-b"))
    expect(sessionColor("-")).toBe("#8b949e")
  })

  test("keeps PiP compact while showing the three highest-cost requests newest first", async () => {
    const html = await Bun.file(dashboardPath).text()

    expect(html).toContain("PIP_TOP_REQUEST_LIMIT = 3")
    expect(html).toContain("topCostHistory")
    expect(html).toContain("pip-top-requests")
    expect(html).toContain("formatRelativeTime(item.ts).label")
    expect(html).toContain("b.ts || '').localeCompare(a.ts || '')")
    expect(html).toContain("width: 240, height: 180")

    const historyUsdSource = extractFunction(html, "historyUsd")
    const topCostHistorySource = extractFunction(html, "topCostHistory")
    const topCostSandbox: {
      topCostHistory?: (history: Array<Record<string, unknown>>) => Array<{
        item: { historyId: string }
        usd: number
      }>
    } = {}
    new Script(`
      const HISTORY_DISPLAY_LIMIT = 50
      const PIP_TOP_REQUEST_LIMIT = 3
      ${historyUsdSource}
      ${topCostHistorySource}
      globalThis.topCostHistory = topCostHistory
    `).runInContext(createContext(topCostSandbox))
    const topCostHistory = topCostSandbox.topCostHistory
    if (!topCostHistory) throw new TypeError("topCostHistory unavailable")
    const request = (historyId: string, ts: string, usd: number) => ({
      historyId,
      ts,
      copilotUsage: { total_nano_aiu: usd * 100000000000 },
    })
    const history = [
      request("old-expensive", "2026-07-14T00:00:00.000Z", 99),
      ...Array.from({ length: 47 }, (_, index) =>
        request(
          `filler-${index}`,
          `2026-07-15T00:${String(index).padStart(2, "0")}:00.000Z`,
          0.001,
        ),
      ),
      request("cost-2-newest", "2026-07-15T01:03:00.000Z", 2),
      request("cost-4-middle", "2026-07-15T01:02:00.000Z", 4),
      request("cost-3-oldest", "2026-07-15T01:01:00.000Z", 3),
    ]

    expect(topCostHistory(history).map(({ item }) => item.historyId)).toEqual([
      "cost-2-newest",
      "cost-4-middle",
      "cost-3-oldest",
    ])
    expect(history[0]?.historyId).toBe("old-expensive")
  })

  test("reads cached tokens from Responses, Chat Completions, and Anthropic usage", async () => {
    const sources = await Promise.all([
      Bun.file(dashboardPath).text(),
      Bun.file(new URL("../../router/dashboard-v2.js", import.meta.url)).text(),
    ])

    for (const source of sources) {
      const sandbox: {
        historyCached?: (item: Record<string, unknown>) => number | null
      } = {}
      const historyCachedSource = extractFunction(source, "historyCached")
      new Script(
        `${historyCachedSource}; globalThis.historyCached = historyCached`,
      ).runInContext(createContext(sandbox))
      const historyCached = sandbox.historyCached
      if (!historyCached) throw new TypeError("historyCached unavailable")

      expect(
        historyCached({
          usage: { input_tokens_details: { cached_tokens: 11 } },
        }),
      ).toBe(11)
      expect(
        historyCached({
          usage: { prompt_tokens_details: { cached_tokens: 22 } },
        }),
      ).toBe(22)
      expect(historyCached({ usage: { cache_read_input_tokens: 33 } })).toBe(33)
    }
  })

  test("keeps the month-end budget status aligned with a below-cap forecast", async () => {
    const sources = await Promise.all([
      Bun.file(dashboardPath).text(),
      Bun.file(new URL("../../router/dashboard-v2.js", import.meta.url)).text(),
    ])
    const instances = [
      {
        headerSnapshot: {
          premiumUsage: { total: 250000, used: 218900 },
        },
      },
    ]

    for (const [index, source] of sources.entries()) {
      const elements = new Map<string, Record<string, unknown>>()
      const byId = (id: string) => {
        const element = elements.get(id) ?? {
          className: "",
          style: {},
          textContent: "",
        }
        elements.set(id, element)
        return element
      }
      class MonthEndDate extends Date {
        constructor(...args: [] | [number, number, number]) {
          if (args.length === 0) {
            super("2026-08-31T12:00:00.000Z")
          } else {
            super(...args)
          }
        }
      }
      const sandbox = {
        Date: MonthEndDate,
        byId,
        renderBudget: undefined as
          ((items: Array<Record<string, unknown>>) => void) | undefined,
      }
      const budgetForecastRatioSource = extractFunction(
        source,
        "budgetForecastRatio",
      )
      const renderBudgetSource = extractFunction(source, "renderBudget")
      new Script(
        `${budgetForecastRatioSource}; ${renderBudgetSource}; globalThis.renderBudget = renderBudget`,
      ).runInContext(createContext(sandbox))
      if (!sandbox.renderBudget) throw new TypeError("renderBudget unavailable")

      sandbox.renderBudget(instances)

      if (index === 0) {
        expect(elements.get("budget-forecast")?.className).toBe(
          "budget-cell budget-good",
        )
      } else {
        expect(elements.get("budget-status")?.textContent).toBe("On track")
      }
    }
  })
})
