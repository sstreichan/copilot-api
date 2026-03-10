// Union types
export type InstanceStatus =
  | "starting"
  | "running"
  | "stopped"
  | "failed"
  | "restarting"
export type TUIAction =
  | "navigate-up"
  | "navigate-down"
  | "restart"
  | "restart-all"
  | "quit"

// Constants
export const FORBIDDEN_FLAGS = [
  "--manual",
  "--claude-code",
  "--show-token",
] as const

// Interfaces
export interface InstanceConfig {
  name: string // required, unique
  port: number // required, unique
  token: string // required
  accountType?: string // default: "individual"
  flags?: Array<string> // default: [] — raw CLI flag strings e.g. ["-M", "-F", "-v"]
}

export interface LogEntry {
  timestamp: number
  level: "info" | "error" | "warn"
  message: string
  instanceId: string
}

export interface InstanceProcess {
  config: InstanceConfig
  status: InstanceStatus
  pid?: number
  logBufferRef?: unknown // filled by LogRingBuffer in T7
}

export interface SupervisorState {
  instances: Map<string, InstanceProcess>
  selectedIndex: number
}

export interface TUIState {
  selectedIndex: number
  layoutMode: "split" | "full"
}
