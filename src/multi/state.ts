import type { TUIAction, InstanceRuntimeStats } from "~/multi/types"

type OnQuit = () => void
type OnRestart = (name: string) => void
type OnRestartAll = () => void

type LogBufferRef = {
  getAll(): Array<string>
}

type LogBufferSupervisor = {
  getLogBuffer(name: string): LogBufferRef | undefined
}

export class TUIStateManager {
  private items: Array<string>
  private onQuit?: OnQuit
  private onRestart?: OnRestart
  private onRestartAll?: OnRestartAll
  private autoSelectEnabled = true
  private manualLockUntil: number | null = null
  private lastAutoSelectAt: number | null = null
  selectedIndex = 1
  private stats: Map<string, InstanceRuntimeStats> = new Map()

  constructor(
    instanceNames: Array<string>,
    options?: {
      onQuit?: OnQuit
      onRestart?: OnRestart
      onRestartAll?: OnRestartAll
    },
  ) {
    this.items = ["[ALL]", ...instanceNames]
    this.onQuit = options?.onQuit
    this.onRestart = options?.onRestart
    this.onRestartAll = options?.onRestartAll
    this.selectedIndex = this.items.length > 1 ? 1 : 0
  }

  navigateUp(): void {
    this.selectedIndex =
      this.selectedIndex === 0 ? this.items.length - 1 : this.selectedIndex - 1
  }

  navigateDown(): void {
    this.selectedIndex =
      this.selectedIndex === this.items.length - 1 ? 0 : this.selectedIndex + 1
  }

  getSelectedName(): string | null {
    if (this.selectedIndex === 0) {
      return null
    }

    return this.items[this.selectedIndex] ?? null
  }

  selectName(name: string): boolean {
    const nextIndex = this.items.indexOf(name)
    if (nextIndex <= 0 || nextIndex === this.selectedIndex) {
      return false
    }

    this.selectedIndex = nextIndex
    return true
  }

  isAllSelected(): boolean {
    return this.selectedIndex === 0
  }

  getItems(): Array<string> {
    return [...this.items]
  }

  getLayoutMode(termWidth: number): "narrow" | "wide" {
    return termWidth >= 75 ? "wide" : "narrow"
  }

  isAutoSelectEnabled(): boolean {
    return this.autoSelectEnabled
  }

  toggleAutoSelect(): boolean {
    this.autoSelectEnabled = !this.autoSelectEnabled
    return this.autoSelectEnabled
  }

  lockManualSelection(now = Date.now(), durationMs = 10_000): void {
    this.manualLockUntil = now + durationMs
  }

  isManualLockActive(now = Date.now()): boolean {
    if (this.manualLockUntil === null) {
      return false
    }

    if (now >= this.manualLockUntil) {
      this.manualLockUntil = null
      return false
    }

    return true
  }

  getLastAutoSelectAt(): number | null {
    return this.lastAutoSelectAt
  }

  recordAutoSelect(now = Date.now()): void {
    this.lastAutoSelectAt = now
  }

  dispatch(action: TUIAction): void {
    switch (action) {
      case "navigate-up": {
        this.navigateUp()
        break
      }
      case "navigate-down": {
        this.navigateDown()
        break
      }
      case "quit": {
        this.onQuit?.()
        break
      }
      case "restart": {
        const name = this.getSelectedName()
        if (name) {
          this.onRestart?.(name)
        }
        break
      }
      case "restart-all": {
        this.onRestartAll?.()
        break
      }
      default: {
        break
      }
    }
  }

  static getInstanceLogs(
    supervisor: LogBufferSupervisor,
    name: string,
  ): Array<string> {
    return supervisor.getLogBuffer(name)?.getAll() ?? []
  }

  static getAllMixedLogs(
    supervisor: LogBufferSupervisor,
    instanceNames: Array<string>,
  ): Array<string> {
    return instanceNames.flatMap((name) => {
      const logs = supervisor.getLogBuffer(name)?.getAll() ?? []
      return logs.map((line) => `[${name}] ${line}`)
    })
  }

  incrementRequestCount(name: string): void {
    const current = this.stats.get(name) ?? {
      requestCount: 0,
      lastActiveAt: null,
    }
    current.requestCount++
    this.stats.set(name, current)
  }

  updateLastActive(name: string): void {
    const current = this.stats.get(name) ?? {
      requestCount: 0,
      lastActiveAt: null,
    }
    current.lastActiveAt = Date.now()
    this.stats.set(name, current)
  }

  clearStats(name: string): void {
    this.stats.set(name, { requestCount: 0, lastActiveAt: null })
  }

  clearAllStats(): void {
    this.stats.clear()
  }

  getStats(name: string): InstanceRuntimeStats {
    const stats = this.stats.get(name)
    if (!stats) {
      return { requestCount: 0, lastActiveAt: null }
    }
    return { ...stats }
  }
}
