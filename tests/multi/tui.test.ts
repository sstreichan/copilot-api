import { describe, expect, it } from "bun:test"

import { TUIStateManager } from "~/multi/state"
import {
  colorizeAllModeLogLine,
  formatInstanceStatsSuffix,
  formatAllModePrefix,
  formatLastActiveLabel,
  getBudgetedDisplayName,
  getFooterDisplayText,
  getLogPanelTitle,
  getLogNavigationState,
  getPauseBadgeText,
  getManualLockLabel,
  getMediumStatsSuffixForWidth,
  getLogViewportLineCount,
  getVisibleRowRange,
  getVisibleLogWindow,
  parseAnsiToStyledText,
  registerRequestActivityListener,
  shouldAutoSelect,
} from "~/multi/tui"

describe("ANSI Parser - Color Support Regression", () => {
  it("should parse 31 (red) and apply color correctly", () => {
    const text = "\x1b[31mRed Text\x1b[0m"
    const result = parseAnsiToStyledText(text)

    // Should have 1 chunk: the red text (first escape before text, second escape has no text before it)
    expect(result.chunks.length).toBe(1)
    const [redChunk] = result.chunks

    // Red chunk should have text
    expect(redChunk.text).toBe("Red Text")

    // Red chunk should have color applied
    expect(redChunk.fg).toBeDefined()

    // Red chunk should not have DIM
    const attributes = redChunk.attributes ?? 0
    const hasDim = (attributes & (1 << 1)) !== 0
    expect(hasDim).toBe(false)
  })

  it("should reset color and attributes with 0m code", () => {
    const text = "\x1b[31mRed\x1b[0m Normal"
    const result = parseAnsiToStyledText(text)

    // Should have 2 chunks: "Red" (with color) and " Normal" (without color)
    expect(result.chunks.length).toBe(2)
    const [redChunk, normalChunk] = result.chunks

    // First chunk: "Red" with color
    expect(redChunk.text).toBe("Red")
    expect(redChunk.fg).toBeDefined()

    // Second chunk: " Normal" without color (reset happened)
    expect(normalChunk.text).toBe(" Normal")
    expect(normalChunk.fg).toBeUndefined()
    expect(normalChunk.attributes ?? 0).toBe(0)
  })

  it("should apply bold attribute correctly", () => {
    const text = "\x1b[1mBold Text\x1b[0m"
    const result = parseAnsiToStyledText(text)

    expect(result.chunks.length).toBe(1)
    const [boldChunk] = result.chunks

    expect(boldChunk.text).toBe("Bold Text")
    // Bold is bit 0
    const BOLD_BIT = 1
    const hasBold =
      boldChunk.attributes && (boldChunk.attributes & BOLD_BIT) !== 0
    expect(hasBold).toBe(true)
  })

  it("should parse 38;5;214 (256-color orange) and apply color", () => {
    const text = "\x1b[38;5;214mOrange Text\x1b[0m"
    const result = parseAnsiToStyledText(text)

    // Should have 1 chunk
    expect(result.chunks.length).toBe(1)
    const [orangeChunk] = result.chunks

    expect(orangeChunk.text).toBe("Orange Text")

    expect(orangeChunk.fg).toBeDefined()
  })

  it("should not apply 256-color but should reset properly", () => {
    const text = "\x1b[38;5;99mPurple\x1b[0m Normal"
    const result = parseAnsiToStyledText(text)

    expect(result.chunks.length).toBe(2)
    const [purpleChunk, normalChunk] = result.chunks

    expect(purpleChunk.text).toBe("Purple")
    expect(purpleChunk.fg).toBeDefined()

    // Normal text: should have no color (reset worked)
    expect(normalChunk.text).toBe(" Normal")
    expect(normalChunk.fg).toBeUndefined()
    expect(normalChunk.attributes ?? 0).toBe(0)
  })

  it("should apply bold but not 256-color (1;38;5;99)", () => {
    const text = "\x1b[1;38;5;99mBold Purple\x1b[0m"
    const result = parseAnsiToStyledText(text)

    expect(result.chunks.length).toBe(1)
    const [boldPurpleChunk] = result.chunks

    expect(boldPurpleChunk.text).toBe("Bold Purple")

    // Bold should be applied
    const BOLD_BIT = 1
    const hasBold =
      boldPurpleChunk.attributes
      && (boldPurpleChunk.attributes & BOLD_BIT) !== 0
    expect(hasBold).toBe(true)

    expect(boldPurpleChunk.fg).toBeDefined()
  })

  it("should skip unsupported extended-color sequences without leaking attributes", () => {
    const text = "\x1b[38;2;10;20;30mNeutral Text\x1b[0m"
    const result = parseAnsiToStyledText(text)

    expect(result.chunks.length).toBe(1)
    const [neutralChunk] = result.chunks

    expect(neutralChunk.text).toBe("Neutral Text")
    expect(neutralChunk.fg).toBeUndefined()
    expect(neutralChunk.bg).toBeUndefined()
    expect(neutralChunk.attributes ?? 0).toBe(0)
  })
})

describe("multi TUI log viewport window", () => {
  it("should use panel height instead of a fixed visible line count", () => {
    const logsLines = Array.from(
      { length: 8 },
      (_, index) => `line-${index + 1}`,
    )

    expect(getLogViewportLineCount(7)).toBe(5)
    expect(getVisibleLogWindow(logsLines, 5, 0)).toEqual({
      visibleLines: ["line-4", "line-5", "line-6", "line-7", "line-8"],
      logScrollOffset: 0,
    })
  })

  it("should clamp upward scroll offset against the actual viewport height", () => {
    const logsLines = Array.from(
      { length: 8 },
      (_, index) => `line-${index + 1}`,
    )

    expect(getVisibleLogWindow(logsLines, 5, 99)).toEqual({
      visibleLines: ["line-1", "line-2", "line-3", "line-4", "line-5"],
      logScrollOffset: 3,
    })
  })
})

describe("multi TUI request stats helpers", () => {
  it("should subscribe to request-activity and expose exact cleanup", () => {
    const listeners = new Map<
      string | symbol,
      Array<(...args: Array<unknown>) => void>
    >()
    const registeredEvents: Array<string | symbol> = []
    const removedEvents: Array<{
      eventName: string | symbol
      listener: (...args: Array<unknown>) => void
    }> = []
    const supervisor = {
      getLogBuffer: () => undefined,
      on: (
        eventName: string | symbol,
        listener: (...args: Array<unknown>) => void,
      ) => {
        registeredEvents.push(eventName)
        listeners.set(eventName, [
          ...(listeners.get(eventName) ?? []),
          listener,
        ])
      },
      off: (
        eventName: string | symbol,
        listener: (...args: Array<unknown>) => void,
      ) => {
        removedEvents.push({ eventName, listener })
        listeners.set(
          eventName,
          (listeners.get(eventName) ?? []).filter(
            (entry) => entry !== listener,
          ),
        )
      },
    }
    const stateManager = new TUIStateManager(["personal", "company"])
    const seenActivity: Array<string> = []

    const cleanup = registerRequestActivityListener(
      supervisor,
      stateManager,
      (name) => {
        seenActivity.push(name)
      },
    )

    expect(registeredEvents).toEqual(["request-activity"])

    const eventListeners = listeners.get("request-activity") ?? []
    expect(eventListeners).toHaveLength(1)

    const [listener] = eventListeners
    expect(listener).toBeDefined()

    listener("company")

    expect(stateManager.getStats("company").requestCount).toBe(1)
    expect(stateManager.getStats("company").lastActiveAt).not.toBeNull()
    expect(seenActivity).toEqual(["company"])

    cleanup()

    expect(removedEvents).toHaveLength(1)
    expect(removedEvents[0]?.eventName).toBe("request-activity")
    expect(removedEvents[0]?.listener).toBe(listener)
    expect(listeners.get("request-activity")).toEqual([])
  })

  it("should format last active labels across time thresholds", () => {
    const now = 10_000

    expect(formatLastActiveLabel(now - 4_000, "wide", now)).toBe("just now")
    expect(formatLastActiveLabel(now - 12_000, "wide", now)).toBe("12s ago")
    expect(formatLastActiveLabel(now - 12_000, "medium", now)).toBe("12s")
    expect(formatLastActiveLabel(now - 5 * 60_000, "wide", now)).toBe("5m ago")
    expect(formatLastActiveLabel(now - 2 * 60 * 60_000, "medium", now)).toBe(
      "2h",
    )
  })

  it("should format stats suffix for wide and medium layouts only", () => {
    const now = 10_000
    const stats = { requestCount: 42, lastActiveAt: now - 3_000 }

    expect(formatInstanceStatsSuffix(stats, "wide", now)).toBe(
      "  [42 req] (just now)",
    )
    expect(formatInstanceStatsSuffix(stats, "medium", now)).toBe(
      "  [42] (just now)",
    )
    expect(formatInstanceStatsSuffix(stats, "narrow", now)).toBe("")
    expect(
      formatInstanceStatsSuffix(
        { requestCount: 0, lastActiveAt: null },
        "wide",
        now,
      ),
    ).toBe("")
  })
})

describe("multi TUI auto-select helpers", () => {
  it("should auto-select only when enabled, unlocked, idle long enough, and rate limit allows", () => {
    const now = 20_000

    expect(
      shouldAutoSelect({
        autoSelectEnabled: true,
        currentInstanceLastActiveAt: now - 5_000,
        currentSelectionName: "personal",
        logAutoFollow: true,
        manualLockActive: false,
        now,
        targetInstanceName: "company",
        lastAutoSelectAt: now - 2_000,
      }),
    ).toBe(true)

    expect(
      shouldAutoSelect({
        autoSelectEnabled: false,
        currentInstanceLastActiveAt: now - 5_000,
        currentSelectionName: "personal",
        logAutoFollow: true,
        manualLockActive: false,
        now,
        targetInstanceName: "company",
        lastAutoSelectAt: now - 2_000,
      }),
    ).toBe(false)

    expect(
      shouldAutoSelect({
        autoSelectEnabled: true,
        currentInstanceLastActiveAt: now - 2_000,
        currentSelectionName: "personal",
        logAutoFollow: true,
        manualLockActive: false,
        now,
        targetInstanceName: "company",
        lastAutoSelectAt: now - 2_000,
      }),
    ).toBe(false)

    expect(
      shouldAutoSelect({
        autoSelectEnabled: true,
        currentInstanceLastActiveAt: now - 5_000,
        currentSelectionName: "personal",
        logAutoFollow: true,
        manualLockActive: true,
        now,
        targetInstanceName: "company",
        lastAutoSelectAt: now - 2_000,
      }),
    ).toBe(false)

    expect(
      shouldAutoSelect({
        autoSelectEnabled: true,
        currentInstanceLastActiveAt: now - 5_000,
        currentSelectionName: "personal",
        logAutoFollow: false,
        manualLockActive: false,
        now,
        targetInstanceName: "company",
        lastAutoSelectAt: now - 2_000,
      }),
    ).toBe(false)

    expect(
      shouldAutoSelect({
        autoSelectEnabled: true,
        currentInstanceLastActiveAt: now - 5_000,
        currentSelectionName: "personal",
        logAutoFollow: true,
        manualLockActive: false,
        now,
        targetInstanceName: "company",
        lastAutoSelectAt: now - 500,
      }),
    ).toBe(false)
  })

  it("should keep ALL sticky while still allowing never-active single-instance selection", () => {
    const now = 20_000

    expect(
      shouldAutoSelect({
        autoSelectEnabled: true,
        currentInstanceLastActiveAt: null,
        currentSelectionName: "personal",
        logAutoFollow: true,
        manualLockActive: false,
        now,
        targetInstanceName: "company",
        lastAutoSelectAt: null,
      }),
    ).toBe(true)

    expect(
      shouldAutoSelect({
        autoSelectEnabled: true,
        currentInstanceLastActiveAt: null,
        currentSelectionName: null,
        logAutoFollow: true,
        manualLockActive: false,
        now,
        targetInstanceName: "company",
        lastAutoSelectAt: null,
      }),
    ).toBe(false)

    expect(
      shouldAutoSelect({
        autoSelectEnabled: true,
        currentInstanceLastActiveAt: now - 5_000,
        currentSelectionName: "company",
        logAutoFollow: true,
        manualLockActive: false,
        now,
        targetInstanceName: "company",
        lastAutoSelectAt: null,
      }),
    ).toBe(false)
  })
})

describe("multi TUI lock label helper", () => {
  it("should keep full label in wide and compact label in medium/narrow", () => {
    expect(getManualLockLabel(true, true, "wide")).toBe(" [locked]")
    expect(getManualLockLabel(true, true, "medium")).toBe(" [L]")
    expect(getManualLockLabel(true, true, "narrow")).toBe(" [L]")
    expect(getManualLockLabel(false, true, "wide")).toBe("")
  })

  it("should drop medium stats suffix before letting the name budget disappear", () => {
    const statsSuffix = "  [1] (just now)"

    expect(
      getMediumStatsSuffixForWidth({
        panelWidth: 28,
        lockSuffix: " [L]",
        portStr: ":4152",
        statsSuffix,
      }),
    ).toBe("")
    expect(
      getMediumStatsSuffixForWidth({
        panelWidth: 40,
        lockSuffix: " [L]",
        portStr: ":4152",
        statsSuffix,
      }),
    ).toBe(statsSuffix)
  })
})

describe("multi TUI log navigation helpers", () => {
  it("should show ASCII paused badge only when log follow is off", () => {
    expect(getPauseBadgeText(true)).toBe("")
    expect(getPauseBadgeText(false)).toBe("[Paused]")
  })

  it("should compute End/Home/PageUp/PageDown navigation from viewport height", () => {
    expect(
      getLogNavigationState({
        action: "end",
        totalLogLineCount: 20,
        visibleLineCount: 5,
        logScrollOffset: 7,
      }),
    ).toEqual({ logScrollOffset: 0, autoFollow: true })

    expect(
      getLogNavigationState({
        action: "home",
        totalLogLineCount: 20,
        visibleLineCount: 5,
        logScrollOffset: 0,
      }),
    ).toEqual({ logScrollOffset: 15, autoFollow: false })

    expect(
      getLogNavigationState({
        action: "page-up",
        totalLogLineCount: 20,
        visibleLineCount: 5,
        logScrollOffset: 0,
      }),
    ).toEqual({ logScrollOffset: 5, autoFollow: false })

    expect(
      getLogNavigationState({
        action: "page-down",
        totalLogLineCount: 20,
        visibleLineCount: 5,
        logScrollOffset: 3,
      }),
    ).toEqual({ logScrollOffset: 0, autoFollow: true })
  })
})

describe("multi TUI log panel title", () => {
  it("should format ALL and selected instance titles", () => {
    expect(getLogPanelTitle(null, [], true)).toBe("ALL")
    expect(
      getLogPanelTitle(
        "personal",
        [
          {
            config: { name: "personal", port: 4151 },
          },
        ] as never,
        true,
      ),
    ).toBe("personal (localhost:4151)")
  })

  it("should append [Paused] when autoFollow is false", () => {
    expect(getLogPanelTitle(null, [], false)).toBe("ALL [Paused]")
    expect(
      getLogPanelTitle(
        "personal",
        [
          {
            config: { name: "personal", port: 4151 },
          },
        ] as never,
        false,
      ),
    ).toBe("personal (localhost:4151) [Paused]")
  })
})

describe("multi TUI ALL-mode log prefixes", () => {
  it("should format full, compact, and hidden prefixes by width", () => {
    expect(formatAllModePrefix("personal", 50)).toBe("[personal] ")
    expect(formatAllModePrefix("personal", 30)).toBe("[P] ")
    expect(formatAllModePrefix("personal", 18)).toBe("")
  })

  it("should colorize known ALL-mode prefixes and leave other lines untouched", () => {
    expect(
      colorizeAllModeLogLine("[personal] hello", 50, ["personal", "company"]),
    ).toBe("\u001b[36m[personal] \u001b[0mhello")
    expect(
      colorizeAllModeLogLine("[company] hello", 30, ["personal", "company"]),
    ).toBe("\u001b[33m[C] \u001b[0mhello")
    expect(colorizeAllModeLogLine("hello", 50, ["personal", "company"])).toBe(
      "hello",
    )
    expect(
      colorizeAllModeLogLine("[unknown] hello", 50, ["personal", "company"]),
    ).toBe("[unknown] hello")
  })

  it("should consume repeated whitespace after ALL-mode prefixes", () => {
    expect(
      colorizeAllModeLogLine("[personal]  hello", 50, ["personal", "company"]),
    ).toBe("\u001b[36m[personal] \u001b[0mhello")
    expect(
      colorizeAllModeLogLine("[personal]\thello", 50, ["personal", "company"]),
    ).toBe("\u001b[36m[personal] \u001b[0mhello")
  })
})

describe("multi TUI final-wave layout helpers", () => {
  it("should not pad a name past the available width budget", () => {
    expect(getBudgetedDisplayName("short", 16, 20)).toHaveLength(16)
    expect(getBudgetedDisplayName("averylongname", 6, 20)).toBe("avery…")
  })

  it("should keep the selected row inside the visible list window", () => {
    expect(getVisibleRowRange(4, 0, 3)).toEqual({ start: 0, end: 3 })
    expect(getVisibleRowRange(4, 3, 3)).toEqual({ start: 1, end: 4 })
    expect(getVisibleRowRange(10, 5, 3)).toEqual({ start: 3, end: 6 })
  })

  it("should keep footer text stable within a 68-column terminal", () => {
    const paused = getFooterDisplayText(68, true, false)
    const pausedAndOff = getFooterDisplayText(68, false, false)

    expect(paused).toContain("[Paused]")
    expect(pausedAndOff).toContain("[auto: off]")
    expect(paused).toHaveLength(68)
    expect(pausedAndOff).toHaveLength(68)
  })
})
