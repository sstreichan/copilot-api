import { consola } from "consola"
import {
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs"
import { createServer } from "node:net"
import { homedir } from "node:os"
import { join } from "node:path"

import type {
  InstanceConfig,
  InstanceProcess,
  InstanceStatus,
  SupervisorState,
} from "~/multi/types"

const PID_DIR_PATH = join(homedir(), ".copilot-api")
const PID_FILE_PATH = join(PID_DIR_PATH, "multi.pid")
const PROCESS_EXIT_TIMEOUT_MS = 5_000
const PROCESS_FORCE_KILL_TIMEOUT_MS = 1_000

type SpawnedProcess = ReturnType<typeof Bun.spawn>
type SupervisorListener = (...arguments_: Array<unknown>) => void

interface ManagedInstance extends InstanceProcess {
  proc?: SpawnedProcess
  logBuffer: LogRingBuffer
}

export class LogRingBuffer {
  private buffer: Array<string> = []
  private capacity: number

  constructor(capacity = 500) {
    this.capacity = capacity
  }

  static mask(line: string): string {
    return line.replaceAll(/g(?:hu|ho|hp)_\S+/g, "***")
  }

  push(...lines: Array<string>): void {
    for (const line of lines) {
      const masked = LogRingBuffer.mask(line)

      if (this.buffer.length >= this.capacity) {
        this.buffer.shift()
      }

      this.buffer.push(masked)
    }
  }

  getAll(): Array<string> {
    return [...this.buffer]
  }

  clear(): void {
    this.buffer = []
  }
}

export class Supervisor {
  private readonly listeners = new Map<
    string | symbol,
    Array<SupervisorListener>
  >()
  private processes = new Map<string, ManagedInstance>()
  private restartingSet = new Set<string>()
  private commandBuilder: (config: InstanceConfig) => Array<string>
  private configs: Array<InstanceConfig>

  constructor(configs: Array<InstanceConfig>) {
    this.configs = configs

    this.commandBuilder = (config) => [
      "bun",
      "src/main.ts",
      "start",
      "-p",
      String(config.port),
      "-a",
      config.accountType ?? "individual",
      ...(config.flags ?? []),
    ]

    for (const config of configs) {
      this.processes.set(config.name, {
        config,
        status: "stopped",
        logBuffer: new LogRingBuffer(500),
        logBufferRef: undefined,
      })
    }
  }

  on(eventName: string | symbol, listener: SupervisorListener): this {
    const listeners = this.listeners.get(eventName) ?? []

    listeners.push(listener)
    this.listeners.set(eventName, listeners)

    return this
  }

  removeAllListeners(eventName?: string | symbol): this {
    if (eventName === undefined) {
      this.listeners.clear()
      return this
    }

    this.listeners.delete(eventName)
    return this
  }

  async startAll(): Promise<void> {
    await this.cleanupOrphans()
    await Promise.all(this.configs.map((config) => this.spawnInstance(config)))
    this.emit("all-started")
  }

  setCommandBuilder(fn: (config: InstanceConfig) => Array<string>): void {
    this.commandBuilder = fn
  }

  async restartInstance(name: string): Promise<void> {
    const entry = this.processes.get(name)
    if (!entry) {
      throw new Error(`Unknown instance: ${name}`)
    }

    if (this.restartingSet.has(name)) {
      return
    }

    this.restartingSet.add(name)

    try {
      this.setStatus(name, "restarting")
      entry.logBuffer.clear()

      await this.terminateEntry(entry)
      await this.spawnInstance(entry.config)
    } finally {
      this.restartingSet.delete(name)
    }
  }

  async stopAll(): Promise<void> {
    await Promise.all(
      [...this.processes.values()].map(async (entry) => {
        await this.terminateEntry(entry)
        this.setStatus(entry.config.name, "stopped")
      }),
    )

    this.cleanupPidFile()
  }

  getState(): SupervisorState {
    return {
      instances: new Map(
        [...this.processes.entries()].map(([name, entry]) => [
          name,
          {
            config: entry.config,
            status: entry.status,
            pid: entry.pid,
            logBufferRef: entry.logBuffer,
          },
        ]),
      ),
      selectedIndex: 0,
    }
  }

  getLogBuffer(name: string): LogRingBuffer | undefined {
    return this.processes.get(name)?.logBuffer
  }

  private emit(
    eventName: string | symbol,
    ...arguments_: Array<unknown>
  ): boolean {
    const listeners = this.listeners.get(eventName)
    if (!listeners || listeners.length === 0) {
      return false
    }

    const activeListeners = listeners.slice()

    for (const listener of activeListeners) {
      listener(...arguments_)
    }

    return true
  }

  private buildCommand(config: InstanceConfig): Array<string> {
    return this.commandBuilder(config)
  }

  private async spawnInstance(config: InstanceConfig): Promise<void> {
    const entry = this.requireEntry(config.name)

    if (await this.isPortInUse(config.port)) {
      this.markStartFailure(
        config.name,
        `Port ${config.port} already in use for instance "${config.name}"`,
      )
      return
    }

    this.setStatus(config.name, "starting")

    try {
      const proc = Bun.spawn(this.buildCommand(config), {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        windowsHide: true,
        env: this.buildChildEnv(config),
      })

      entry.proc = proc
      entry.pid = proc.pid
      entry.logBufferRef = entry.logBuffer

      this.setStatus(config.name, "running")
      this.syncPidFile()

      void this.streamOutput(config.name, proc.stdout, entry.logBuffer)
      void this.streamOutput(config.name, proc.stderr, entry.logBuffer)
      void this.monitorExit(config.name, proc)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.markStartFailure(
        config.name,
        `Failed to spawn instance "${config.name}": ${message}`,
      )
    }
  }

  private requireEntry(name: string): ManagedInstance {
    const entry = this.processes.get(name)
    if (!entry) {
      throw new Error(`Unknown instance: ${name}`)
    }

    return entry
  }

  private setStatus(name: string, status: InstanceStatus): void {
    const entry = this.processes.get(name)
    if (!entry) {
      return
    }

    entry.status = status
    this.emit("status-change", name, status)
  }

  private markStartFailure(name: string, message: string): void {
    const entry = this.requireEntry(name)

    entry.proc = undefined
    entry.pid = undefined
    entry.logBuffer.push(`[ERROR] ${message}`)

    this.syncPidFile()
    this.setStatus(name, "failed")
    this.emit("log", name, LogRingBuffer.mask(`[ERROR] ${message}`))
  }

  private async monitorExit(name: string, proc: SpawnedProcess): Promise<void> {
    const exitCode = await proc.exited

    this.emit("child-exit", name, exitCode)

    const entry = this.processes.get(name)
    if (!entry || entry.proc !== proc) {
      return
    }

    entry.proc = undefined
    entry.pid = undefined
    this.syncPidFile()

    const nextStatus: InstanceStatus = exitCode === 0 ? "stopped" : "failed"
    this.setStatus(name, nextStatus)
  }

  private async terminateEntry(entry: ManagedInstance): Promise<void> {
    const proc = entry.proc

    entry.proc = undefined
    entry.pid = undefined
    this.syncPidFile()

    if (!proc) {
      return
    }

    try {
      proc.kill("SIGTERM")
    } catch (error) {
      consola.debug(`Failed to send SIGTERM to ${entry.config.name}:`, error)
    }

    const exitedAfterTerm = await this.waitForProcessExit(
      proc,
      PROCESS_EXIT_TIMEOUT_MS,
    )
    if (exitedAfterTerm) {
      return
    }

    try {
      proc.kill("SIGKILL")
    } catch (error) {
      consola.debug(`Failed to send SIGKILL to ${entry.config.name}:`, error)
    }

    await this.waitForProcessExit(proc, PROCESS_FORCE_KILL_TIMEOUT_MS)
  }

  private async waitForProcessExit(
    proc: SpawnedProcess,
    timeoutMs: number,
  ): Promise<boolean> {
    return Promise.race([
      proc.exited.then(() => true),
      this.sleep(timeoutMs).then(() => false),
    ])
  }

  private async streamOutput(
    name: string,
    stream: ReadableStream<Uint8Array<ArrayBuffer>> | number | undefined | null,
    buffer: LogRingBuffer,
  ): Promise<void> {
    if (!stream || typeof stream === "number") {
      return
    }

    const reader = stream.getReader()
    const decoder = new TextDecoder()
    let pending = ""

    try {
      while (true) {
        const { done, value } = await reader.read()

        if (done) {
          break
        }

        pending += decoder.decode(value, { stream: true })

        const lines = pending.split(/\r?\n/)
        pending = lines.pop() ?? ""

        for (const line of lines) {
          this.recordLogLine(name, line, buffer)
        }
      }

      pending += decoder.decode()
      this.recordLogLine(name, pending, buffer)
    } catch (error) {
      consola.debug(`Stream read error for ${name}:`, error)
    } finally {
      reader.releaseLock()
    }
  }

  private recordLogLine(
    name: string,
    rawLine: string,
    buffer: LogRingBuffer,
  ): void {
    const line = rawLine.trimEnd()
    if (!line.trim()) {
      return
    }

    buffer.push(line)

    const maskedLine = buffer.getAll().at(-1)
    if (maskedLine) {
      this.emit("log", name, maskedLine)
    }
  }

  private async isPortInUse(port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const server = createServer()

      server.once("error", () => {
        resolve(true)
      })

      server.once("listening", () => {
        server.close(() => resolve(false))
      })

      server.listen(port)
    })
  }

  private async cleanupOrphans(): Promise<void> {
    if (!existsSync(PID_FILE_PATH)) {
      return
    }

    const content = readFileSync(PID_FILE_PATH, "utf8")
    const pids = content
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const [, pidValue] = line.split(":")
        return Number.parseInt(pidValue, 10)
      })
      .filter((pid) => Number.isInteger(pid) && pid > 0)

    for (const pid of pids) {
      await this.killOrphan(pid)
    }

    this.cleanupPidFile()
  }

  private async killOrphan(pid: number): Promise<void> {
    try {
      process.kill(pid, 0)
    } catch {
      return
    }

    if (!this.isOurProcess(pid)) {
      return
    }

    try {
      process.kill(pid, "SIGTERM")
    } catch {
      return
    }

    const exitedAfterTerm = await this.waitForPidExit(
      pid,
      PROCESS_EXIT_TIMEOUT_MS,
    )
    if (exitedAfterTerm) {
      return
    }

    try {
      process.kill(pid, "SIGKILL")
    } catch {
      return
    }

    await this.waitForPidExit(pid, PROCESS_FORCE_KILL_TIMEOUT_MS)
  }

  private isOurProcess(pid: number): boolean {
    if (process.platform === "win32") {
      // Windows: No /proc filesystem to verify process identity.
      // Return false to skip orphan cleanup, preventing false positives.
      return false
    }

    try {
      const cmdline = readFileSync(`/proc/${pid}/cmdline`, "utf8")
      return cmdline.includes("copilot-api") || cmdline.includes("main.ts")
    } catch {
      return false
    }
  }

  private async waitForPidExit(
    pid: number,
    timeoutMs: number,
  ): Promise<boolean> {
    const deadline = Date.now() + timeoutMs

    while (Date.now() < deadline) {
      if (!this.isPidAlive(pid)) {
        return true
      }

      await this.sleep(100)
    }

    return !this.isPidAlive(pid)
  }

  private isPidAlive(pid: number): boolean {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }

  private syncPidFile(): void {
    const lines = [...this.processes.values()]
      .filter((entry) => entry.pid !== undefined)
      .map((entry) => `${entry.config.name}:${entry.pid}`)

    if (lines.length === 0) {
      this.cleanupPidFile()
      return
    }

    mkdirSync(PID_DIR_PATH, { recursive: true })
    writeFileSync(PID_FILE_PATH, `${lines.join("\n")}\n`)
  }

  private cleanupPidFile(): void {
    try {
      unlinkSync(PID_FILE_PATH)
    } catch (error) {
      consola.debug("Failed to clean up PID file:", error)
    }
  }

  private buildChildEnv(config: InstanceConfig): Record<string, string> {
    const deduped = new Map<string, [string, string]>()

    for (const [key, value] of Object.entries(process.env)) {
      if (value === undefined) {
        continue
      }

      if (process.platform === "win32") {
        const normalizedKey = key.toUpperCase()
        const outputKey = normalizedKey === "PATH" ? "Path" : key

        deduped.set(normalizedKey, [outputKey, value])
        continue
      }

      deduped.set(key, [key, value])
    }

    deduped.set("COPILOT_API_GITHUB_TOKEN", [
      "COPILOT_API_GITHUB_TOKEN",
      config.token,
    ])

    return Object.fromEntries(deduped.values())
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }
}
