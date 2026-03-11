import type { TUIAction } from "~/multi/types"

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
  selectedIndex = 1

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

  isAllSelected(): boolean {
    return this.selectedIndex === 0
  }

  getItems(): Array<string> {
    return [...this.items]
  }

  getLayoutMode(termWidth: number): "narrow" | "wide" {
    return termWidth >= 75 ? "wide" : "narrow"
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
}
