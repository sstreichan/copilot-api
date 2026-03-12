/* eslint-disable max-lines -- Project constraints keep the multi TUI renderer, ANSI parser, and input handlers colocated in this single file. */

import type { MouseEvent, TextChunk } from "@opentui/core"

import {
  RGBA,
  black,
  blue,
  brightBlack,
  brightBlue,
  brightCyan,
  brightGreen,
  brightMagenta,
  brightRed,
  brightWhite,
  brightYellow,
  createCliRenderer,
  BoxRenderable as Box,
  TextRenderable as Text,
  MouseButton,
  StyledText,
  cyan,
  dim,
  green,
  magenta,
  red,
  stringToStyledText,
  white,
  yellow,
} from "@opentui/core"

import type { InstanceProcess, InstanceRuntimeStats } from "./types"

import { TUIStateManager } from "./state"

export interface TuiHandle {
  update(instances: Array<InstanceProcess>): void
  destroy(): void
}

export interface TuiOptions {
  onRestart: (name: string) => void
  onQuit: () => void
  supervisor: {
    getLogBuffer: (name: string) => { getAll: () => Array<string> } | undefined
    off?: (
      eventName: string | symbol,
      listener: (...arguments_: Array<unknown>) => void,
    ) => unknown
    on?: (
      eventName: string | symbol,
      listener: (...arguments_: Array<unknown>) => void,
    ) => unknown
  }
}

function maskToken(text: string): string {
  return text.replaceAll(/g(?:hu|ho|hp)_\S+/g, "***")
}

function styledTextFromParts(parts: Array<string | TextChunk>): StyledText {
  const chunks: Array<TextChunk> = []

  for (const part of parts) {
    if (typeof part === "string") {
      chunks.push(...stringToStyledText(part).chunks)
      continue
    }
    chunks.push(part)
  }

  return new StyledText(chunks)
}

const ANSI_ATTRIBUTE_BOLD = 1
const ANSI_ATTRIBUTE_DIM = 2
const ANSI_ATTRIBUTE_UNDERLINE = 8
const ANSI_COLOR_MODE_256 = 5
const ANSI_ESCAPE = "\u001B"
const ANSI_EXTENDED_BACKGROUND = 48
const ANSI_EXTENDED_FOREGROUND = 38
const ANSI_EXTENDED_COLOR_PARAMETER_COUNTS = new Map<number, number>([
  [ANSI_COLOR_MODE_256, 1],
  [2, 3],
])
const ANSI_256_COLOR_LEVELS = [0, 95, 135, 175, 215, 255] as const
const ANSI_RESET = `${ANSI_ESCAPE}[0m`
const AUTO_SELECT_IDLE_MS = 3_000
const AUTO_SELECT_RATE_LIMIT_MS = 1_000
const ALL_MODE_PREFIX_COLOR_CODES = [36, 33, 35, 34, 32, 31] as const
const ALL_MODE_PREFIX_COMPACT_MIN_WIDTH = 24
const ALL_MODE_PREFIX_FULL_MIN_WIDTH = 40
const INSTANCE_LIST_PREFIX_WIDTH = 4
const LOG_PANEL_CHROME_ROWS = 2
const MIN_VISIBLE_TRUNCATED_NAME_WIDTH = 2

type CliRenderer = Awaited<ReturnType<typeof createCliRenderer>>
type BoxNode = InstanceType<typeof Box>
type TextNode = InstanceType<typeof Text>

interface TuiUiElements {
  contentBox: BoxNode
  listBox: BoxNode
  listText: TextNode
  logsBox: BoxNode
  logsText: TextNode
  headerText: TextNode
  footerText: TextNode
}

interface RenderLogsOptions {
  allMode: boolean
  logsLines: Array<string>
  layoutMode: "narrow" | "wide"
  columns: number
  instanceNames: Array<string>
}

interface LogViewportState {
  logScrollOffset: number
  autoFollow: boolean
}

type StatsDisplayMode = "wide" | "medium" | "narrow"

type MouseScrollRegion = Pick<BoxNode, "x" | "y" | "width" | "height">

interface AutoSelectDecisionOptions {
  autoSelectEnabled: boolean
  currentInstanceLastActiveAt: number | null
  currentSelectionName: string | null
  logAutoFollow: boolean
  lastAutoSelectAt: number | null
  manualLockActive: boolean
  now: number
  targetInstanceName: string
}

interface MediumStatsSuffixWidthOptions {
  panelWidth: number
  lockSuffix: string
  portStr: string
  statsSuffix: string
}

interface VisibleRowRange {
  start: number
  end: number
}

type LogNavigationAction = "end" | "home" | "page-down" | "page-up"
type AllModePrefixDisplayMode = "compact" | "full" | "hidden"

interface LogNavigationStateOptions {
  action: LogNavigationAction
  logScrollOffset: number
  totalLogLineCount: number
  visibleLineCount: number
}

interface RenderTuiParams {
  currentInstances: Array<InstanceProcess>
  stateManager: TUIStateManager
  options: TuiOptions
  instanceNames: Array<string>
  ui: TuiUiElements
  columns: number
  viewport: LogViewportState
}

type InstanceListRow = Array<string | TextChunk>

interface RenderInstanceListOptions {
  instances: Array<InstanceProcess>
  stateManager: TUIStateManager
  panelWidth: number
  visibleRowCount: number
}

interface InstanceRowRenderContext {
  stateManager: TUIStateManager
  panelWidth: number
  displayMode: StatsDisplayMode
  manualLockActive: boolean
  maxNameLength: number
  now: number
  selectedName: string | null
}

interface InstanceRowDisplayState {
  isSelected: boolean
  lockSuffix: string
  portStr: string
  statsSuffix: string
  typeAbbr: string
}

function createAnsiSgrRegExp(): RegExp {
  return new RegExp(`${ANSI_ESCAPE}\\[([0-9;]*)m`, "g")
}

function resolveChunkColor(chunk: TextChunk): RGBA {
  if (chunk.fg === undefined) {
    throw new Error("Expected chunk foreground color")
  }

  return chunk.fg
}

const ANSI_FOREGROUND_COLORS = new Map<number, RGBA>([
  [30, resolveChunkColor(black(""))],
  [31, resolveChunkColor(red(""))],
  [32, resolveChunkColor(green(""))],
  [33, resolveChunkColor(yellow(""))],
  [34, resolveChunkColor(blue(""))],
  [35, resolveChunkColor(magenta(""))],
  [36, resolveChunkColor(cyan(""))],
  [37, resolveChunkColor(white(""))],
  [90, resolveChunkColor(brightBlack(""))],
  [91, resolveChunkColor(brightRed(""))],
  [92, resolveChunkColor(brightGreen(""))],
  [93, resolveChunkColor(brightYellow(""))],
  [94, resolveChunkColor(brightBlue(""))],
  [95, resolveChunkColor(brightMagenta(""))],
  [96, resolveChunkColor(brightCyan(""))],
  [97, resolveChunkColor(brightWhite(""))],
])

const ANSI_256_BASE_COLORS = [
  resolveChunkColor(black("")),
  resolveChunkColor(red("")),
  resolveChunkColor(green("")),
  resolveChunkColor(yellow("")),
  resolveChunkColor(blue("")),
  resolveChunkColor(magenta("")),
  resolveChunkColor(cyan("")),
  resolveChunkColor(white("")),
  resolveChunkColor(brightBlack("")),
  resolveChunkColor(brightRed("")),
  resolveChunkColor(brightGreen("")),
  resolveChunkColor(brightYellow("")),
  resolveChunkColor(brightBlue("")),
  resolveChunkColor(brightMagenta("")),
  resolveChunkColor(brightCyan("")),
  resolveChunkColor(brightWhite("")),
]

interface AnsiStyleState {
  fg?: RGBA
  bg?: RGBA
  attributes: number
}

function createAnsi256Color(code: number): RGBA | undefined {
  if (code < 0 || code > 255) {
    return undefined
  }

  if (code < ANSI_256_BASE_COLORS.length) {
    return ANSI_256_BASE_COLORS[code]
  }

  if (code < 232) {
    const cubeIndex = code - 16
    const redIndex = Math.floor(cubeIndex / 36)
    const greenIndex = Math.floor((cubeIndex % 36) / 6)
    const blueIndex = cubeIndex % 6

    return RGBA.fromInts(
      ANSI_256_COLOR_LEVELS[redIndex],
      ANSI_256_COLOR_LEVELS[greenIndex],
      ANSI_256_COLOR_LEVELS[blueIndex],
    )
  }

  const grayLevel = 8 + (code - 232) * 10
  return RGBA.fromInts(grayLevel, grayLevel, grayLevel)
}

function createTextChunk(
  text: string,
  state: AnsiStyleState,
): TextChunk | null {
  if (text.length === 0) {
    return null
  }

  const chunk: TextChunk = {
    __isChunk: true,
    text,
  }

  if (state.fg !== undefined) {
    chunk.fg = state.fg
  }

  if (state.bg !== undefined) {
    chunk.bg = state.bg
  }

  if (state.attributes !== 0) {
    chunk.attributes = state.attributes
  }

  return chunk
}

function parseAnsiCodes(params: string): Array<number> {
  if (params === "") {
    return [0]
  }

  return params
    .split(";")
    .map((param) => Number.parseInt(param, 10))
    .filter((code) => Number.isFinite(code))
}

export function applyAnsiSgrCode(code: number, state: AnsiStyleState) {
  switch (code) {
    case 0: {
      state.fg = undefined
      state.bg = undefined
      state.attributes = 0
      return
    }
    case 1: {
      state.attributes |= ANSI_ATTRIBUTE_BOLD
      return
    }
    case 2: {
      state.attributes |= ANSI_ATTRIBUTE_DIM
      return
    }
    case 4: {
      state.attributes |= ANSI_ATTRIBUTE_UNDERLINE
      return
    }
    case 22: {
      state.attributes &= ~(ANSI_ATTRIBUTE_BOLD | ANSI_ATTRIBUTE_DIM)
      return
    }
    case 24: {
      state.attributes &= ~ANSI_ATTRIBUTE_UNDERLINE
      return
    }
    case 39: {
      state.fg = undefined
      return
    }
    case 49: {
      state.bg = undefined
      return
    }
    default: {
      const foregroundColor = ANSI_FOREGROUND_COLORS.get(code)
      if (foregroundColor !== undefined) {
        state.fg = foregroundColor
      }
    }
  }
}

function applyAnsiSgrCodes(codes: Array<number>, state: AnsiStyleState) {
  for (let index = 0; index < codes.length; index += 1) {
    const code = codes[index]

    if (
      (code === ANSI_EXTENDED_FOREGROUND || code === ANSI_EXTENDED_BACKGROUND)
      && index + 1 < codes.length
    ) {
      const mode = codes[index + 1]
      const additionalParamCount =
        ANSI_EXTENDED_COLOR_PARAMETER_COUNTS.get(mode)

      if (mode === ANSI_COLOR_MODE_256) {
        const paletteIndex = codes.at(index + 2)
        const color =
          paletteIndex === undefined ? undefined : (
            createAnsi256Color(paletteIndex)
          )

        if (color !== undefined) {
          state[code === ANSI_EXTENDED_FOREGROUND ? "fg" : "bg"] = color
        }

        index += 2
        continue
      }

      if (additionalParamCount !== undefined) {
        index += 1 + additionalParamCount
        continue
      }
    }

    applyAnsiSgrCode(code, state)
  }
}

export function parseAnsiToStyledText(text: string): StyledText {
  const chunks: Array<TextChunk> = []
  const state: AnsiStyleState = { attributes: 0 }
  let lastIndex = 0

  for (const match of text.matchAll(createAnsiSgrRegExp())) {
    const startIndex = match.index
    const chunk = createTextChunk(text.slice(lastIndex, startIndex), state)

    if (chunk !== null) {
      chunks.push(chunk)
    }

    applyAnsiSgrCodes(parseAnsiCodes(match[1]), state)

    lastIndex = startIndex + match[0].length
  }

  const trailingChunk = createTextChunk(text.slice(lastIndex), state)
  if (trailingChunk !== null) {
    chunks.push(trailingChunk)
  }

  return new StyledText(chunks)
}

function getVisibleTextLength(text: string): number {
  return text.replaceAll(createAnsiSgrRegExp(), "").length
}

function truncateAnsiLine(text: string, maxVisibleLength: number): string {
  if (maxVisibleLength <= 0) {
    return ""
  }

  if (getVisibleTextLength(text) <= maxVisibleLength) {
    return text
  }

  const visibleBudget = Math.max(0, maxVisibleLength - 1)
  let visibleLength = 0
  let lastIndex = 0
  let result = ""

  for (const match of text.matchAll(createAnsiSgrRegExp())) {
    const startIndex = match.index
    const plainSegment = text.slice(lastIndex, startIndex)
    const remaining = visibleBudget - visibleLength

    if (remaining <= 0) {
      return `${result}…${ANSI_RESET}`
    }

    if (plainSegment.length > remaining) {
      return `${result}${plainSegment.slice(0, remaining)}…${ANSI_RESET}`
    }

    result += plainSegment
    visibleLength += plainSegment.length
    result += match[0]
    lastIndex = startIndex + match[0].length
  }

  if (visibleLength < visibleBudget) {
    result += text.slice(lastIndex, lastIndex + (visibleBudget - visibleLength))
  }

  return `${result}…${ANSI_RESET}`
}

function getSelectionParts(selected: boolean): Array<string | TextChunk> {
  return selected ? [cyan("►"), " "] : ["  "]
}

function getInstanceStatusIndicatorChunk(instance: InstanceProcess): TextChunk {
  switch (instance.status) {
    case "running": {
      return green("●")
    }
    case "failed": {
      return red("✖")
    }
    case "starting":
    case "restarting": {
      return yellow("◉")
    }
    default: {
      return dim("○")
    }
  }
}

function getInstanceNameChunk(
  instance: InstanceProcess,
  name = instance.config.name,
): TextChunk {
  switch (instance.status) {
    case "running": {
      return green(name)
    }
    case "failed": {
      return red(name)
    }
    case "starting":
    case "restarting": {
      return yellow(name)
    }
    default: {
      return dim(name)
    }
  }
}

function renderHeader(runningCount: number, totalCount: number): StyledText {
  return styledTextFromParts([
    ` copilot-api multi | ${runningCount}/${totalCount} running`,
  ])
}

export function getFooterDisplayText(
  columns: number,
  autoSelectEnabled: boolean,
  autoFollow: boolean,
): string {
  const badges = [
    getPauseBadgeText(autoFollow),
    autoSelectEnabled ? "" : "[auto: off]",
  ].filter((badge) => badge !== "")
  const candidates = [
    "[↑/↓] Navigate  [r] Restart  [c/C] Clear  [q] Quit  [a] Auto",
    "[↑/↓] Nav  [r] Restart  [c/C] Clear  [q] Quit  [a] Auto",
    "[↑/↓] Nav [r] Re [c/C] Cl [q] Q [a] Auto",
  ].map((candidate) =>
    badges.length === 0 ? candidate : `${candidate} ${badges.join(" ")}`,
  )

  const text =
    candidates.find((candidate) => candidate.length <= columns)
    ?? candidates.at(-1)
    ?? ""

  return text.length >= columns ? text.slice(0, columns) : text.padEnd(columns)
}

export function getLogPanelTitle(
  selectedName: string | null,
  instances: Array<{ config: { name: string; port: number } }>,
  autoFollow: boolean,
): string {
  const baseTitle = (() => {
    if (selectedName === null) {
      return "ALL"
    }

    const selectedInstance = instances.find(
      (instance) => instance.config.name === selectedName,
    )

    if (selectedInstance === undefined) {
      return selectedName
    }

    return `${selectedInstance.config.name} (localhost:${selectedInstance.config.port})`
  })()

  const badge = getPauseBadgeText(autoFollow)
  return badge ? `${baseTitle} ${badge}` : baseTitle
}

export function getPauseBadgeText(autoFollow: boolean): string {
  return autoFollow ? "" : "[Paused]"
}

function renderFooter(
  columns: number,
  autoSelectEnabled: boolean,
  autoFollow: boolean,
): StyledText {
  return styledTextFromParts([
    getFooterDisplayText(columns, autoSelectEnabled, autoFollow),
  ])
}

export function formatLastActiveLabel(
  lastActiveAt: number | null,
  mode: Exclude<StatsDisplayMode, "narrow">,
  now = Date.now(),
): string | null {
  if (lastActiveAt === null) return null

  const elapsedSeconds = Math.max(0, Math.floor((now - lastActiveAt) / 1000))
  const compact = mode === "medium"

  if (elapsedSeconds < 5) return "just now"
  if (elapsedSeconds < 60)
    return compact ? `${elapsedSeconds}s` : `${elapsedSeconds}s ago`

  const elapsedMinutes = Math.floor(elapsedSeconds / 60)
  if (elapsedSeconds < 3600)
    return compact ? `${elapsedMinutes}m` : `${elapsedMinutes}m ago`

  const elapsedHours = Math.floor(elapsedSeconds / 3600)
  return compact ? `${elapsedHours}h` : `${elapsedHours}h ago`
}

export function formatInstanceStatsSuffix(
  stats: InstanceRuntimeStats,
  mode: StatsDisplayMode,
  now = Date.now(),
): string {
  if (mode === "narrow" || stats.requestCount === 0) return ""

  const lastActiveLabel = formatLastActiveLabel(stats.lastActiveAt, mode, now)
  if (lastActiveLabel === null) return ""

  const requestLabel =
    mode === "wide" ? `[${stats.requestCount} req]` : `[${stats.requestCount}]`
  return `  ${requestLabel} (${lastActiveLabel})`
}

function getStatsDisplayMode(panelWidth: number): StatsDisplayMode {
  if (panelWidth > 40) return "wide"
  return panelWidth >= 25 ? "medium" : "narrow"
}

function getAllModePrefixDisplayMode(
  panelWidth: number,
): AllModePrefixDisplayMode {
  if (panelWidth >= ALL_MODE_PREFIX_FULL_MIN_WIDTH) return "full"
  if (panelWidth >= ALL_MODE_PREFIX_COMPACT_MIN_WIDTH) return "compact"
  return "hidden"
}

function getAllModePrefixColorCode(instanceIndex: number): number {
  return ALL_MODE_PREFIX_COLOR_CODES[
    instanceIndex % ALL_MODE_PREFIX_COLOR_CODES.length
  ]
}

export function formatAllModePrefix(name: string, panelWidth: number): string {
  switch (getAllModePrefixDisplayMode(panelWidth)) {
    case "full": {
      return `[${name}] `
    }
    case "compact": {
      return `[${name.charAt(0).toUpperCase()}] `
    }
    case "hidden": {
      return ""
    }
    default: {
      return ""
    }
  }
}

export function colorizeAllModeLogLine(
  line: string,
  panelWidth: number,
  instanceNames: Array<string>,
): string {
  const match = /^\[([^\]]+)\](.*)$/.exec(line)
  if (match === null) {
    return line
  }

  const [, instanceName, contentWithLeadingWhitespace] = match
  const content = contentWithLeadingWhitespace.trimStart()
  const instanceIndex = instanceNames.indexOf(instanceName)
  if (instanceIndex === -1) {
    return line
  }

  const prefix = formatAllModePrefix(instanceName, panelWidth)
  if (prefix === "") {
    return content
  }

  const colorCode = getAllModePrefixColorCode(instanceIndex)
  return `${ANSI_ESCAPE}[${colorCode}m${prefix}${ANSI_RESET}${content}`
}

export function getBudgetedDisplayName(
  rawName: string,
  availableWidth: number,
  maxNameLength: number,
): string {
  const safeAvailableWidth = Math.max(0, availableWidth)

  if (rawName.length > safeAvailableWidth) {
    return truncateName(rawName, safeAvailableWidth)
  }

  return rawName.padEnd(Math.min(maxNameLength, safeAvailableWidth))
}

export function getVisibleRowRange(
  totalRowCount: number,
  selectedIndex: number,
  visibleRowCount: number,
): VisibleRowRange {
  const safeVisibleRowCount = Math.max(1, visibleRowCount)
  const clampedSelectedIndex = Math.min(
    Math.max(0, selectedIndex),
    Math.max(0, totalRowCount - 1),
  )

  if (totalRowCount <= safeVisibleRowCount) {
    return { start: 0, end: totalRowCount }
  }

  const start = Math.min(
    Math.max(0, clampedSelectedIndex - safeVisibleRowCount + 1),
    totalRowCount - safeVisibleRowCount,
  )

  return { start, end: start + safeVisibleRowCount }
}

export function getManualLockLabel(
  selected: boolean,
  manualLockActive: boolean,
  mode: StatsDisplayMode,
): string {
  if (!selected || !manualLockActive) {
    return ""
  }

  return mode === "wide" ? " [locked]" : " [L]"
}

function getCurrentLogLines(
  supervisor: TuiOptions["supervisor"],
  instanceNames: Array<string>,
  selectedName: string | null,
): Array<string> {
  return selectedName === null ?
      TUIStateManager.getAllMixedLogs(supervisor, instanceNames)
    : TUIStateManager.getInstanceLogs(supervisor, selectedName)
}

function getMaxLogScrollOffset(
  totalLogLineCount: number,
  visibleLineCount: number,
): number {
  return Math.max(0, totalLogLineCount - visibleLineCount)
}

export function getLogNavigationState({
  action,
  logScrollOffset,
  totalLogLineCount,
  visibleLineCount,
}: LogNavigationStateOptions): LogViewportState {
  const maxLogScrollOffset = getMaxLogScrollOffset(
    totalLogLineCount,
    visibleLineCount,
  )
  const step = Math.max(1, visibleLineCount)

  switch (action) {
    case "end": {
      return { logScrollOffset: 0, autoFollow: true }
    }
    case "home": {
      return {
        logScrollOffset: maxLogScrollOffset,
        autoFollow: maxLogScrollOffset === 0,
      }
    }
    case "page-up": {
      const nextOffset = Math.min(maxLogScrollOffset, logScrollOffset + step)
      return { logScrollOffset: nextOffset, autoFollow: nextOffset === 0 }
    }
    case "page-down": {
      const nextOffset = Math.max(0, logScrollOffset - step)
      return { logScrollOffset: nextOffset, autoFollow: nextOffset === 0 }
    }
    default: {
      return { logScrollOffset, autoFollow: logScrollOffset === 0 }
    }
  }
}

export function getMediumStatsSuffixForWidth({
  panelWidth,
  lockSuffix,
  portStr,
  statsSuffix,
}: MediumStatsSuffixWidthOptions): string {
  if (statsSuffix === "") {
    return statsSuffix
  }

  const availForNameWithStats =
    panelWidth
    - INSTANCE_LIST_PREFIX_WIDTH
    - `${lockSuffix}${portStr}${statsSuffix}`.length

  return availForNameWithStats >= MIN_VISIBLE_TRUNCATED_NAME_WIDTH ? statsSuffix
    : ""
}

export function shouldAutoSelect({
  autoSelectEnabled,
  currentInstanceLastActiveAt,
  currentSelectionName,
  logAutoFollow,
  lastAutoSelectAt,
  manualLockActive,
  now,
  targetInstanceName,
}: AutoSelectDecisionOptions): boolean {
  if (!autoSelectEnabled || manualLockActive || !logAutoFollow) {
    return false
  }

  if (currentSelectionName === targetInstanceName) {
    return false
  }

  if (
    lastAutoSelectAt !== null
    && now - lastAutoSelectAt < AUTO_SELECT_RATE_LIMIT_MS
  ) {
    return false
  }

  if (currentSelectionName === null) {
    return false
  }

  if (currentInstanceLastActiveAt === null) {
    return true
  }

  return now - currentInstanceLastActiveAt >= AUTO_SELECT_IDLE_MS
}

function getAccountTypeAbbr(
  accountType: InstanceProcess["config"]["accountType"],
): string {
  if (accountType === "business") return "biz"
  return accountType === "enterprise" ? "ent" : "ind"
}

function truncateName(name: string, available: number): string {
  if (available <= 0) return ""
  if (name.length > available) return `${name.slice(0, available - 1)}…`
  return name
}

function getInstanceRowDisplayState(
  instance: InstanceProcess,
  context: InstanceRowRenderContext,
): InstanceRowDisplayState {
  const isSelected = context.selectedName === instance.config.name
  const accountType = instance.config.accountType ?? "individual"
  const typeAbbr = getAccountTypeAbbr(accountType)
  const portStr = `:${instance.config.port}`
  const statsSuffix = formatInstanceStatsSuffix(
    context.stateManager.getStats(instance.config.name),
    context.displayMode,
    context.now,
  )
  const lockSuffix = getManualLockLabel(
    isSelected,
    context.manualLockActive,
    context.displayMode,
  )

  return {
    isSelected,
    lockSuffix,
    portStr,
    statsSuffix,
    typeAbbr,
  }
}

function renderWideInstanceRow(
  instance: InstanceProcess,
  displayState: InstanceRowDisplayState,
  context: Pick<InstanceRowRenderContext, "maxNameLength" | "panelWidth">,
): InstanceListRow {
  const suffix = `${displayState.lockSuffix}  ${displayState.portStr}  [${displayState.typeAbbr}]  (${instance.status})${displayState.statsSuffix}`
  const availForName =
    context.panelWidth - INSTANCE_LIST_PREFIX_WIDTH - suffix.length
  const displayName = getBudgetedDisplayName(
    instance.config.name,
    availForName,
    context.maxNameLength,
  )

  return [
    ...getSelectionParts(displayState.isSelected),
    getInstanceStatusIndicatorChunk(instance),
    " ",
    getInstanceNameChunk(instance, displayName),
    displayState.lockSuffix,
    "  ",
    dim(displayState.portStr),
    "  ",
    dim(`[${displayState.typeAbbr}]`),
    `  (${instance.status})`,
    displayState.statsSuffix,
  ]
}

function renderMediumInstanceRow(
  instance: InstanceProcess,
  displayState: InstanceRowDisplayState,
  context: Pick<InstanceRowRenderContext, "maxNameLength" | "panelWidth">,
): InstanceListRow {
  const visibleStatsSuffix = getMediumStatsSuffixForWidth({
    panelWidth: context.panelWidth,
    lockSuffix: displayState.lockSuffix,
    portStr: displayState.portStr,
    statsSuffix: displayState.statsSuffix,
  })
  const suffix = `${displayState.lockSuffix}${displayState.portStr}${visibleStatsSuffix}`
  const availForName =
    context.panelWidth - INSTANCE_LIST_PREFIX_WIDTH - suffix.length
  const displayName = getBudgetedDisplayName(
    instance.config.name,
    availForName,
    context.maxNameLength,
  )

  return [
    ...getSelectionParts(displayState.isSelected),
    getInstanceStatusIndicatorChunk(instance),
    " ",
    getInstanceNameChunk(instance, displayName),
    displayState.lockSuffix,
    dim(displayState.portStr),
    visibleStatsSuffix,
  ]
}

function renderNarrowInstanceRow(
  instance: InstanceProcess,
  displayState: InstanceRowDisplayState,
  panelWidth: number,
): InstanceListRow {
  const suffix = `${displayState.lockSuffix}  ${displayState.portStr}`
  const availForName = panelWidth - INSTANCE_LIST_PREFIX_WIDTH - suffix.length
  const displayName = truncateName(instance.config.name, availForName)

  return [
    ...getSelectionParts(displayState.isSelected),
    getInstanceStatusIndicatorChunk(instance),
    " ",
    getInstanceNameChunk(instance, displayName),
    displayState.lockSuffix,
    "  ",
    dim(displayState.portStr),
  ]
}

function renderInstanceRow(
  instance: InstanceProcess,
  context: InstanceRowRenderContext,
): InstanceListRow {
  const displayState = getInstanceRowDisplayState(instance, context)

  if (context.displayMode === "wide") {
    return renderWideInstanceRow(instance, displayState, context)
  }

  if (context.displayMode === "medium") {
    return renderMediumInstanceRow(instance, displayState, context)
  }

  return renderNarrowInstanceRow(instance, displayState, context.panelWidth)
}

function renderInstanceList({
  instances,
  stateManager,
  panelWidth,
  visibleRowCount,
}: RenderInstanceListOptions): StyledText {
  const now = Date.now()
  const selectedName = stateManager.getSelectedName()
  const context: InstanceRowRenderContext = {
    stateManager,
    panelWidth,
    displayMode: getStatsDisplayMode(panelWidth),
    manualLockActive: stateManager.isManualLockActive(now),
    maxNameLength: instances.reduce(
      (width, instance) => Math.max(width, instance.config.name.length),
      0,
    ),
    now,
    selectedName,
  }
  const rows: Array<InstanceListRow> = [
    [...getSelectionParts(stateManager.isAllSelected()), "[ALL]"],
    ...instances.map((instance) => renderInstanceRow(instance, context)),
  ]

  const selectedLabel = selectedName ?? "[ALL]"
  const selectedIndex = Math.max(
    0,
    stateManager.getItems().indexOf(selectedLabel),
  )
  const { start, end } = getVisibleRowRange(
    rows.length,
    selectedIndex,
    visibleRowCount,
  )

  const listParts: InstanceListRow = []
  for (const [index, row] of rows.slice(start, end).entries()) {
    if (index > 0) {
      listParts.push("\n")
    }

    listParts.push(...row)
  }

  return styledTextFromParts(listParts)
}

export function getLogViewportLineCount(panelHeight: number): number {
  return Math.max(1, panelHeight - LOG_PANEL_CHROME_ROWS)
}

export function getVisibleLogWindow(
  logsLines: Array<string>,
  visibleLineCount: number,
  logScrollOffset: number,
): { visibleLines: Array<string>; logScrollOffset: number } {
  const maxLogScrollOffset = Math.max(0, logsLines.length - visibleLineCount)
  const nextLogScrollOffset = Math.min(
    Math.max(0, logScrollOffset),
    maxLogScrollOffset,
  )
  const end = logsLines.length - nextLogScrollOffset
  const start = Math.max(0, end - visibleLineCount)

  return {
    visibleLines: logsLines.slice(start, end),
    logScrollOffset: nextLogScrollOffset,
  }
}

function renderLogs({
  allMode,
  logsLines,
  layoutMode,
  columns,
  instanceNames,
}: RenderLogsOptions): StyledText {
  const panelWidth =
    layoutMode === "narrow" ? columns - 2 : Math.floor(columns * 0.7) - 2

  const maskedLogs = logsLines
    .map((line) => {
      const maskedLine = maskToken(line)
      const renderedLine =
        allMode ?
          colorizeAllModeLogLine(maskedLine, panelWidth, instanceNames)
        : maskedLine

      return truncateAnsiLine(renderedLine, panelWidth)
    })
    .join(`${ANSI_RESET}\n`)

  return parseAnsiToStyledText(maskedLogs)
}

function applyLayoutMode(
  layoutMode: "narrow" | "wide",
  ui: Pick<TuiUiElements, "contentBox" | "listBox" | "logsBox">,
  context?: { instanceCount: number; totalRows: number },
) {
  if (layoutMode === "narrow") {
    ui.contentBox.flexDirection = "column"
    ui.listBox.width = "100%"
    ui.logsBox.width = "100%"

    if (context) {
      // Content-aware: instances + 2 (borders + ALL option), cap at 40%
      const idealHeight = context.instanceCount + 2
      const maxHeight = Math.floor(context.totalRows * 0.4)
      const listHeight = Math.max(4, Math.min(idealHeight, maxHeight))
      const logsHeight = Math.max(5, context.totalRows - listHeight)
      ui.listBox.height = listHeight
      ui.logsBox.height = logsHeight
    } else {
      ui.listBox.height = "50%"
      ui.logsBox.height = "50%"
    }
    return
  }

  ui.contentBox.flexDirection = "row"
  ui.listBox.width = "30%"
  ui.listBox.height = "100%"
  ui.logsBox.width = "70%"
  ui.logsBox.height = "100%"
}

function createTuiLayout(renderer: CliRenderer): TuiUiElements {
  const rootBox = new Box(renderer, {
    width: "100%",
    height: "100%",
    flexDirection: "column",
  })
  renderer.root.add(rootBox)

  const headerBox = new Box(renderer, { width: "100%", height: 1 })
  const headerText = new Text(renderer, { content: "" })
  headerBox.add(headerText)

  const contentBox = new Box(renderer, {
    width: "100%",
    flexGrow: 1,
    flexDirection: "row",
  })

  const listBox = new Box(renderer, {
    flexDirection: "column",
    border: true,
    width: "30%",
  })
  const listText = new Text(renderer, { content: "" })
  listBox.add(listText)

  const logsBox = new Box(renderer, {
    flexDirection: "column",
    border: true,
    flexGrow: 1,
    title: "",
    titleAlignment: "left",
  })
  const logsText = new Text(renderer, { content: "" })
  logsBox.add(logsText)

  const footerBox = new Box(renderer, { width: "100%", height: 1 })
  const footerText = new Text(renderer, { content: "" })
  footerBox.add(footerText)

  rootBox.add(headerBox)
  rootBox.add(contentBox)
  rootBox.add(footerBox)
  contentBox.add(listBox)
  contentBox.add(logsBox)

  return {
    contentBox,
    listBox,
    listText,
    logsBox,
    logsText,
    headerText,
    footerText,
  }
}

function renderTui({
  currentInstances,
  stateManager,
  options,
  instanceNames,
  ui,
  columns,
  viewport,
}: RenderTuiParams): number {
  const layoutMode = stateManager.getLayoutMode(columns)
  applyLayoutMode(layoutMode, ui, {
    instanceCount: currentInstances.length,
    totalRows: process.stdout.rows || 24,
  })

  const runningCount = currentInstances.filter(
    (instance) => instance.status === "running",
  ).length

  ui.headerText.content = renderHeader(runningCount, currentInstances.length)
  ui.footerText.content = renderFooter(
    columns,
    stateManager.isAutoSelectEnabled(),
    viewport.autoFollow,
  )
  const listPanelWidth =
    layoutMode === "narrow" ? columns - 2 : Math.floor(columns * 0.3) - 2
  const visibleListRowCount = Math.max(1, ui.listBox.height - 2)
  ui.listText.content = renderInstanceList({
    instances: currentInstances,
    stateManager,
    panelWidth: listPanelWidth,
    visibleRowCount: visibleListRowCount,
  })

  const selectedName = stateManager.getSelectedName()
  ui.logsBox.title = getLogPanelTitle(
    selectedName,
    currentInstances,
    viewport.autoFollow,
  )
  const logsLines = getCurrentLogLines(
    options.supervisor,
    instanceNames,
    selectedName,
  )

  const visibleLogLineCount = getLogViewportLineCount(ui.logsBox.height)
  const { visibleLines, logScrollOffset: nextLogScrollOffset } =
    getVisibleLogWindow(
      logsLines,
      visibleLogLineCount,
      viewport.autoFollow ? 0 : viewport.logScrollOffset,
    )

  ui.logsText.content = renderLogs({
    allMode: selectedName === null,
    logsLines: visibleLines,
    layoutMode,
    columns,
    instanceNames,
  })

  return nextLogScrollOffset
}

function createInputHandler(
  stateManager: TUIStateManager,
  navigateSelection: (
    action: "navigate-up" | "navigate-down",
    count?: number,
  ) => void,
  actions: {
    clearCurrentStats: () => void
    clearAllStats: () => void
    pageDownLogs: () => void
    pageUpLogs: () => void
    scrollLogsToBottom: () => void
    scrollLogsToTop: () => void
    toggleAutoSelect: () => void
  },
): (sequence: string) => boolean {
  return (sequence) => {
    if (sequence === "\x03" || sequence === "q") {
      stateManager.dispatch("quit")
      return true
    }
    if (sequence === "\x1B[A" || sequence === "k") {
      navigateSelection("navigate-up")
      return true
    }
    if (sequence === "\x1B[B" || sequence === "j") {
      navigateSelection("navigate-down")
      return true
    }
    if (sequence === "r") {
      if (stateManager.isAllSelected()) {
        stateManager.dispatch("restart-all")
      } else {
        stateManager.dispatch("restart")
      }
      return true
    }
    return handleTuiActionSequence(sequence, actions)
  }
}

function handleTuiActionSequence(
  sequence: string,
  actions: {
    clearCurrentStats: () => void
    clearAllStats: () => void
    pageDownLogs: () => void
    pageUpLogs: () => void
    scrollLogsToBottom: () => void
    scrollLogsToTop: () => void
    toggleAutoSelect: () => void
  },
): boolean {
  switch (sequence) {
    case "c": {
      actions.clearCurrentStats()
      return true
    }
    case "C": {
      actions.clearAllStats()
      return true
    }
    case "a": {
      actions.toggleAutoSelect()
      return true
    }
    case "\x1B[F":
    case "\x1B[4~": {
      actions.scrollLogsToBottom()
      return true
    }
    case "\x1B[H":
    case "\x1B[1~": {
      actions.scrollLogsToTop()
      return true
    }
    case "\x1B[5~": {
      actions.pageUpLogs()
      return true
    }
    case "\x1B[6~": {
      actions.pageDownLogs()
      return true
    }
    default: {
      return false
    }
  }
}

function createListScrollHandler(
  navigateSelection: (
    action: "navigate-up" | "navigate-down",
    count?: number,
  ) => void,
  region: MouseScrollRegion,
): (event: MouseEvent) => void {
  return (event) => {
    if (!isMouseEventInsideRegion(event, region)) {
      return
    }

    const direction = getScrollDirection(event)
    if (direction === null) {
      return
    }

    event.preventDefault()
    event.stopPropagation()

    navigateSelection(
      direction === "up" ? "navigate-up" : "navigate-down",
      getScrollStep(event),
    )
  }
}

function createLogsScrollHandler(
  logState: LogViewportState,
  render: () => void,
  region: MouseScrollRegion,
): (event: MouseEvent) => void {
  return (event) => {
    if (!isMouseEventInsideRegion(event, region)) {
      return
    }

    const direction = getScrollDirection(event)
    if (direction === null) {
      return
    }

    event.preventDefault()
    event.stopPropagation()

    const step = getScrollStep(event)

    if (direction === "up") {
      logState.logScrollOffset += step
      logState.autoFollow = false
    } else {
      logState.logScrollOffset = Math.max(0, logState.logScrollOffset - step)
      if (logState.logScrollOffset === 0) {
        logState.autoFollow = true
      }
    }

    render()
  }
}

function isMouseEventInsideRegion(
  event: MouseEvent,
  region: MouseScrollRegion,
): boolean {
  return (
    event.x >= region.x
    && event.x < region.x + region.width
    && event.y >= region.y
    && event.y < region.y + region.height
  )
}

function getScrollDirection(event: MouseEvent): "up" | "down" | null {
  const wheelUpButton: number = MouseButton.WHEEL_UP
  const wheelDownButton: number = MouseButton.WHEEL_DOWN

  if (event.scroll?.direction === "up" || event.scroll?.direction === "down") {
    return event.scroll.direction
  }

  if (event.button === wheelUpButton) {
    return "up"
  }
  if (event.button === wheelDownButton) {
    return "down"
  }

  return null
}

function getScrollStep(event: MouseEvent): number {
  return Math.max(1, event.scroll?.delta ?? 1)
}

function bindMouseScrollHandlers({
  logState,
  navigateSelection,
  render,
  ui,
}: {
  logState: LogViewportState
  navigateSelection: (
    action: "navigate-up" | "navigate-down",
    count?: number,
  ) => void
  render: () => void
  ui: Pick<TuiUiElements, "listBox" | "listText" | "logsBox" | "logsText">
}): void {
  const handleListScroll = createListScrollHandler(
    navigateSelection,
    ui.listBox,
  )
  const handleLogsScroll = createLogsScrollHandler(logState, render, ui.logsBox)

  ui.listBox.onMouseScroll = handleListScroll
  ui.listText.onMouseScroll = handleListScroll
  ui.logsBox.onMouseScroll = handleLogsScroll
  ui.logsText.onMouseScroll = handleLogsScroll
}

function createStatsActions(
  stateManager: TUIStateManager,
  render: () => void,
): {
  clearCurrentStats: () => void
  clearAllStats: () => void
  toggleAutoSelect: () => void
} {
  return {
    clearCurrentStats: () => {
      const selectedName = stateManager.getSelectedName()
      if (selectedName === null) return

      stateManager.clearStats(selectedName)
      render()
    },
    clearAllStats: () => {
      stateManager.clearAllStats()
      render()
    },
    toggleAutoSelect: () => {
      stateManager.toggleAutoSelect()
      render()
    },
  }
}

function createLogNavigationActions({
  getCurrentLogLineCount,
  getVisibleLineCount,
  logState,
  render,
}: {
  getCurrentLogLineCount: () => number
  getVisibleLineCount: () => number
  logState: LogViewportState
  render: () => void
}): {
  pageDownLogs: () => void
  pageUpLogs: () => void
  scrollLogsToBottom: () => void
  scrollLogsToTop: () => void
} {
  function applyLogNavigation(action: LogNavigationAction) {
    const nextState = getLogNavigationState({
      action,
      logScrollOffset: logState.logScrollOffset,
      totalLogLineCount: getCurrentLogLineCount(),
      visibleLineCount: getVisibleLineCount(),
    })

    logState.logScrollOffset = nextState.logScrollOffset
    logState.autoFollow = nextState.autoFollow
    render()
  }

  return {
    pageDownLogs: () => {
      applyLogNavigation("page-down")
    },
    pageUpLogs: () => {
      applyLogNavigation("page-up")
    },
    scrollLogsToBottom: () => {
      applyLogNavigation("end")
    },
    scrollLogsToTop: () => {
      applyLogNavigation("home")
    },
  }
}

function maybeAutoSelectOnRequest({
  logState,
  name,
  render,
  resetLogScroll,
  stateManager,
}: {
  logState: LogViewportState
  name: string
  render: () => void
  resetLogScroll: () => void
  stateManager: TUIStateManager
}): void {
  const now = Date.now()
  const currentSelectionName = stateManager.getSelectedName()
  const currentSelectionLastActiveAt =
    currentSelectionName === null ? null : (
      stateManager.getStats(currentSelectionName).lastActiveAt
    )

  if (
    !shouldAutoSelect({
      autoSelectEnabled: stateManager.isAutoSelectEnabled(),
      currentInstanceLastActiveAt: currentSelectionLastActiveAt,
      currentSelectionName,
      logAutoFollow: logState.autoFollow,
      lastAutoSelectAt: stateManager.getLastAutoSelectAt(),
      manualLockActive: stateManager.isManualLockActive(now),
      now,
      targetInstanceName: name,
    })
  ) {
    return
  }

  if (!stateManager.selectName(name)) {
    return
  }

  stateManager.recordAutoSelect(now)
  resetLogScroll()
  render()
}

export function registerRequestActivityListener(
  supervisor: TuiOptions["supervisor"],
  stateManager: TUIStateManager,
  onRequestActivity: (name: string) => void,
): () => void {
  const listener = (name: unknown) => {
    if (typeof name !== "string") return

    stateManager.incrementRequestCount(name)
    stateManager.updateLastActive(name)
    onRequestActivity(name)
  }

  supervisor.on?.("request-activity", listener)

  return () => {
    supervisor.off?.("request-activity", listener)
  }
}

export async function createTui(
  initialInstances: Array<InstanceProcess>,
  options: TuiOptions,
): Promise<TuiHandle> {
  const renderer = await createCliRenderer({
    exitOnCtrlC: false,
    useMouse: true,
    useConsole: false,
  })
  let currentInstances = [...initialInstances]
  const instanceNames = initialInstances.map((i) => i.config.name)
  const stateManager = new TUIStateManager(instanceNames, {
    onQuit: options.onQuit,
    onRestart: (name) => options.onRestart(name),
    onRestartAll: () => {
      for (const i of currentInstances) options.onRestart(i.config.name)
    },
  })
  const logState: LogViewportState = {
    logScrollOffset: 0,
    autoFollow: true,
  }
  const ui = createTuiLayout(renderer)

  function resetLogScroll() {
    logState.logScrollOffset = 0
    logState.autoFollow = true
  }
  function render() {
    logState.logScrollOffset = renderTui({
      currentInstances,
      stateManager,
      options,
      instanceNames,
      ui,
      columns: process.stdout.columns || 80,
      viewport: logState,
    })

    renderer.requestRender()
  }
  function navigateSelection(
    action: "navigate-up" | "navigate-down",
    count = 1,
  ) {
    for (let index = 0; index < count; index += 1) {
      stateManager.dispatch(action)
    }

    stateManager.lockManualSelection()
    resetLogScroll()
    render()
  }
  const statsActions = createStatsActions(stateManager, render)
  const logNavigationActions = createLogNavigationActions({
    getCurrentLogLineCount: () => {
      const selectedName = stateManager.getSelectedName()

      return getCurrentLogLines(options.supervisor, instanceNames, selectedName)
        .length
    },
    getVisibleLineCount: () => getLogViewportLineCount(ui.logsBox.height),
    logState,
    render,
  })
  const cleanupRequestActivityListener = registerRequestActivityListener(
    options.supervisor,
    stateManager,
    (name) => {
      maybeAutoSelectOnRequest({
        logState,
        name,
        render,
        resetLogScroll,
        stateManager,
      })
    },
  )
  bindMouseScrollHandlers({ logState, navigateSelection, render, ui })
  renderer.addInputHandler(
    createInputHandler(stateManager, navigateSelection, {
      ...statsActions,
      ...logNavigationActions,
    }),
  )
  process.stdout.on("resize", render)
  renderer.start()
  render()

  return {
    update(instances: Array<InstanceProcess>) {
      currentInstances = instances
      render()
    },
    destroy() {
      process.stdout.off("resize", render)
      cleanupRequestActivityListener()
      renderer.destroy()
    },
  }
}
