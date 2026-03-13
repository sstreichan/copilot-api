import type { MouseEvent, RGBA, TextChunk } from "@opentui/core"

import {
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

import type { InstanceProcess } from "./types"

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
const ANSI_ESCAPE = "\u001B"
const ANSI_RESET = `${ANSI_ESCAPE}[0m`
const MAX_VISIBLE_LOG_LINES = 100

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
  logsLines: Array<string>
  layoutMode: "narrow" | "wide"
  columns: number
  logScrollOffset: number
}

interface LogViewportState {
  logScrollOffset: number
  autoFollow: boolean
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

interface AnsiStyleState {
  fg?: RGBA
  attributes: number
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

function applyAnsiSgrCode(code: number, state: AnsiStyleState) {
  switch (code) {
    case 0: {
      state.fg = undefined
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
    default: {
      const foregroundColor = ANSI_FOREGROUND_COLORS.get(code)
      if (foregroundColor !== undefined) {
        state.fg = foregroundColor
      }
    }
  }
}

function parseAnsiToStyledText(text: string): StyledText {
  const chunks: Array<TextChunk> = []
  const state: AnsiStyleState = { attributes: 0 }
  let lastIndex = 0

  for (const match of text.matchAll(createAnsiSgrRegExp())) {
    const startIndex = match.index
    const chunk = createTextChunk(text.slice(lastIndex, startIndex), state)

    if (chunk !== null) {
      chunks.push(chunk)
    }

    for (const code of parseAnsiCodes(match[1])) {
      applyAnsiSgrCode(code, state)
    }

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

function renderFooter(): StyledText {
  return styledTextFromParts([dim("[↑/↓] Navigate  [r] Restart  [q] Quit")])
}

function renderInstanceList(
  instances: Array<InstanceProcess>,
  stateManager: TUIStateManager,
): StyledText {
  const listParts: Array<string | TextChunk> = []
  const selectedName = stateManager.getSelectedName()
  const maxNameLength = instances.reduce(
    (width, instance) => Math.max(width, instance.config.name.length),
    0,
  )

  listParts.push(...getSelectionParts(stateManager.isAllSelected()), "[ALL]")

  for (const instance of instances) {
    const accountType = instance.config.accountType ?? "individual"
    const paddedName = instance.config.name.padEnd(maxNameLength)

    listParts.push(
      "\n",
      ...getSelectionParts(selectedName === instance.config.name),
      getInstanceStatusIndicatorChunk(instance),
      " ",
      getInstanceNameChunk(instance, paddedName),
      "  ",
      dim(`:${instance.config.port}`),
      "  ",
      dim(`[${accountType}]`),
      `  (${instance.status})`,
    )
  }

  return styledTextFromParts(listParts)
}

function renderLogs({
  logsLines,
  layoutMode,
  columns,
  logScrollOffset,
}: RenderLogsOptions): StyledText {
  const panelWidth =
    layoutMode === "narrow" ? columns - 2 : Math.floor(columns * 0.7) - 2

  const end = logScrollOffset === 0 ? undefined : -logScrollOffset
  const visibleLogs = logsLines.slice(
    -(MAX_VISIBLE_LOG_LINES + logScrollOffset),
    end,
  )

  const maskedLogs = visibleLogs
    .map((line) => truncateAnsiLine(maskToken(line), panelWidth))
    .join(`${ANSI_RESET}\n`)

  return parseAnsiToStyledText(maskedLogs)
}

function applyLayoutMode(
  layoutMode: "narrow" | "wide",
  ui: Pick<TuiUiElements, "contentBox" | "listBox" | "logsBox">,
) {
  if (layoutMode === "narrow") {
    ui.contentBox.flexDirection = "column"
    ui.listBox.width = "100%"
    ui.listBox.height = "50%"
    ui.logsBox.width = "100%"
    ui.logsBox.height = "50%"
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
  applyLayoutMode(layoutMode, ui)

  const runningCount = currentInstances.filter(
    (instance) => instance.status === "running",
  ).length

  ui.headerText.content = renderHeader(runningCount, currentInstances.length)
  ui.footerText.content = renderFooter()
  ui.listText.content = renderInstanceList(currentInstances, stateManager)

  const selectedName = stateManager.getSelectedName()
  const logsLines =
    selectedName === null ?
      TUIStateManager.getAllMixedLogs(options.supervisor, instanceNames)
    : TUIStateManager.getInstanceLogs(options.supervisor, selectedName)

  const maxLogScrollOffset = Math.max(
    0,
    logsLines.length - MAX_VISIBLE_LOG_LINES,
  )
  const nextLogScrollOffset = Math.min(
    viewport.autoFollow ? 0 : viewport.logScrollOffset,
    maxLogScrollOffset,
  )

  ui.logsText.content = renderLogs({
    logsLines,
    layoutMode,
    columns,
    logScrollOffset: nextLogScrollOffset,
  })

  return nextLogScrollOffset
}

function createInputHandler(
  stateManager: TUIStateManager,
  navigateSelection: (
    action: "navigate-up" | "navigate-down",
    count?: number,
  ) => void,
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

    return false
  }
}

function createListScrollHandler(
  navigateSelection: (
    action: "navigate-up" | "navigate-down",
    count?: number,
  ) => void,
): (event: MouseEvent) => void {
  return (event) => {
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
): (event: MouseEvent) => void {
  return (event) => {
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
    resetLogScroll()
    render()
  }

  const handleListScroll = createListScrollHandler(navigateSelection)
  const handleLogsScroll = createLogsScrollHandler(logState, render)

  ui.listBox.onMouseScroll = handleListScroll
  ui.listText.onMouseScroll = handleListScroll
  ui.logsBox.onMouseScroll = handleLogsScroll
  ui.logsText.onMouseScroll = handleLogsScroll

  renderer.addInputHandler(createInputHandler(stateManager, navigateSelection))

  // Resize listener
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
      renderer.destroy()
    },
  }
}
