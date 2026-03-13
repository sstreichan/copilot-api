import { afterEach, describe, expect, test } from "bun:test"
import { join } from "node:path"

import type { InstanceConfig, InstanceStatus } from "~/multi/types"

import { LogRingBuffer, Supervisor } from "~/multi/supervisor"

const FIXTURE_CHILD_PATH = join(
  import.meta.dir,
  "../fixtures/multi/fixture-child.ts",
)
const WAIT_TIMEOUT_MS = 8_000
const POLL_INTERVAL_MS = 50

let supervisor: Supervisor | undefined

interface PrivateSupervisorAccess {
  buildChildEnv(config: InstanceConfig): Record<string, string>
  buildCommand(config: InstanceConfig): Array<string>
  killOrphan(pid: number): Promise<void>
  recordLogLine(name: string, rawLine: string, buffer: LogRingBuffer): void
}

interface WaitOptions<T> {
  readValue: () => T | Promise<T>
  predicate: (value: T) => boolean
  label: string
  timeoutMs?: number
}

afterEach(async () => {
  if (!supervisor) {
    return
  }

  try {
    await supervisor.stopAll()
  } finally {
    supervisor = undefined
  }
})

function createConfigs(
  instances: Array<{ name: string; port: number; flags?: Array<string> }>,
): Array<InstanceConfig> {
  return instances.map(({ name, port, flags }) => ({
    name,
    port,
    token: "ghu_test_token_12345",
    accountType: "individual",
    flags: flags ?? [],
  }))
}

function createFixtureSupervisor(configs: Array<InstanceConfig>): Supervisor {
  const nextSupervisor = new Supervisor(configs)

  nextSupervisor.setCommandBuilder((config) => [
    "bun",
    FIXTURE_CHILD_PATH,
    "--port",
    String(config.port),
    "--name",
    config.name,
    ...(config.flags ?? []),
  ])

  supervisor = nextSupervisor
  return nextSupervisor
}

function getPrivateSupervisorAccess(
  currentSupervisor: Supervisor,
): PrivateSupervisorAccess {
  return currentSupervisor as unknown as PrivateSupervisorAccess
}

function getInstanceState(currentSupervisor: Supervisor, name: string) {
  const instance = currentSupervisor.getState().instances.get(name)
  if (!instance) {
    throw new Error(`Missing instance state for ${name}`)
  }

  return instance
}

async function waitUntil<T>(options: WaitOptions<T>): Promise<T> {
  const { readValue, predicate, label, timeoutMs = WAIT_TIMEOUT_MS } = options
  const deadline = Date.now() + timeoutMs
  let lastValue: T | undefined

  while (Date.now() < deadline) {
    lastValue = await readValue()
    if (predicate(lastValue)) {
      return lastValue
    }

    await Bun.sleep(POLL_INTERVAL_MS)
  }

  throw new Error(
    `Timed out waiting for ${label}. Last value: ${formatValue(lastValue)}`,
  )
}

function formatValue(value: unknown): string {
  if (value instanceof Map) {
    return JSON.stringify([...value.entries()])
  }

  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function waitForStatus(
  currentSupervisor: Supervisor,
  name: string,
  status: InstanceStatus,
): Promise<void> {
  await waitUntil({
    readValue: () => getInstanceState(currentSupervisor, name).status,
    predicate: (currentStatus) => currentStatus === status,
    label: `${name} status=${status}`,
  })
}

async function waitForHealth(port: number): Promise<void> {
  await waitUntil({
    readValue: async () => {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/health`)
        if (!response.ok) {
          return false
        }

        const payload = (await response.json()) as {
          status?: string
          port?: number
        }

        return payload.status === "ok" && payload.port === port
      } catch {
        return false
      }
    },
    predicate: (ready) => ready,
    label: `health endpoint on port ${port}`,
  })
}

async function waitForLogLine(
  currentSupervisor: Supervisor,
  name: string,
  fragment: string,
): Promise<Array<string>> {
  return waitUntil({
    readValue: () => currentSupervisor.getLogBuffer(name)?.getAll() ?? [],
    predicate: (lines) => lines.some((line) => line.includes(fragment)),
    label: `${name} log containing ${fragment}`,
  })
}

describe("Supervisor", () => {
  describe("startup", () => {
    test("startAll should bring instances to running state", async () => {
      const currentSupervisor = createFixtureSupervisor(
        createConfigs([
          { name: "alpha", port: 9901 },
          { name: "beta", port: 9902 },
        ]),
      )

      const statusEvents: Array<[string, InstanceStatus]> = []
      currentSupervisor.on(
        "status-change",
        (name: unknown, status: unknown) => {
          statusEvents.push([String(name), status as InstanceStatus])
        },
      )

      await currentSupervisor.startAll()
      await waitForStatus(currentSupervisor, "alpha", "running")
      await waitForStatus(currentSupervisor, "beta", "running")
      await waitForHealth(9901)
      await waitForHealth(9902)

      expect(statusEvents).toContainEqual(["alpha", "running"])
      expect(statusEvents).toContainEqual(["beta", "running"])
    })

    test("getState should expose pid, status, and log buffer refs", async () => {
      const currentSupervisor = createFixtureSupervisor(
        createConfigs([
          { name: "alpha", port: 9901 },
          { name: "beta", port: 9902 },
        ]),
      )

      await currentSupervisor.startAll()
      await waitForStatus(currentSupervisor, "alpha", "running")
      await waitForStatus(currentSupervisor, "beta", "running")

      const state = currentSupervisor.getState()
      const alpha = state.instances.get("alpha")
      const beta = state.instances.get("beta")

      expect(alpha?.status).toBe("running")
      expect(beta?.status).toBe("running")
      expect(typeof alpha?.pid).toBe("number")
      expect(typeof beta?.pid).toBe("number")
      expect(alpha?.pid).toBeGreaterThan(0)
      expect(beta?.pid).toBeGreaterThan(0)
      expect(alpha?.logBufferRef).toBeInstanceOf(LogRingBuffer)
      expect(beta?.logBufferRef).toBeInstanceOf(LogRingBuffer)
    })

    test("stdout output should flow into the log buffer", async () => {
      const currentSupervisor = createFixtureSupervisor(
        createConfigs([{ name: "alpha", port: 9901 }]),
      )

      await currentSupervisor.startAll()

      const lines = await waitForLogLine(
        currentSupervisor,
        "alpha",
        "Server started on :9901",
      )

      expect(
        lines.some((line) => line.includes("[alpha] Server started on :9901")),
      ).toBeTrue()
    })
  })

  describe("restart", () => {
    test("restartInstance should only restart the targeted instance", async () => {
      const currentSupervisor = createFixtureSupervisor(
        createConfigs([
          { name: "alpha", port: 9901 },
          { name: "beta", port: 9902 },
        ]),
      )

      await currentSupervisor.startAll()
      await waitForStatus(currentSupervisor, "alpha", "running")
      await waitForStatus(currentSupervisor, "beta", "running")
      await waitForHealth(9901)
      await waitForHealth(9902)

      const alphaPidBefore = getInstanceState(currentSupervisor, "alpha").pid
      const betaPidBefore = getInstanceState(currentSupervisor, "beta").pid

      await currentSupervisor.restartInstance("alpha")
      await waitForStatus(currentSupervisor, "alpha", "running")
      await waitForHealth(9901)
      await waitForHealth(9902)

      const alphaPidAfter = getInstanceState(currentSupervisor, "alpha").pid
      const betaPidAfter = getInstanceState(currentSupervisor, "beta").pid

      expect(alphaPidBefore).toBeDefined()
      expect(betaPidBefore).toBeDefined()
      expect(alphaPidAfter).toBeDefined()
      expect(alphaPidAfter).not.toBe(alphaPidBefore)
      expect(betaPidAfter).toBe(betaPidBefore)
    })

    test("restartInstance should emit a restarting transition before returning to running", async () => {
      const currentSupervisor = createFixtureSupervisor(
        createConfigs([{ name: "alpha", port: 9901 }]),
      )

      const seenStatuses: Array<InstanceStatus> = []
      currentSupervisor.on(
        "status-change",
        (name: unknown, status: unknown) => {
          if (String(name) === "alpha") {
            seenStatuses.push(status as InstanceStatus)
          }
        },
      )

      await currentSupervisor.startAll()
      await waitForStatus(currentSupervisor, "alpha", "running")

      seenStatuses.length = 0

      await currentSupervisor.restartInstance("alpha")
      await waitForStatus(currentSupervisor, "alpha", "running")

      const restartingIndex = seenStatuses.indexOf("restarting")
      const runningIndex = seenStatuses.lastIndexOf("running")

      expect(restartingIndex).toBeGreaterThanOrEqual(0)
      expect(runningIndex).toBeGreaterThan(restartingIndex)
      expect(seenStatuses.at(-1)).toBe("running")
    })

    test("restartInstance should clear the previous log buffer contents", async () => {
      const currentSupervisor = createFixtureSupervisor(
        createConfigs([{ name: "alpha", port: 9901 }]),
      )

      await currentSupervisor.startAll()
      await waitForStatus(currentSupervisor, "alpha", "running")

      const logBuffer = currentSupervisor.getLogBuffer("alpha")
      expect(logBuffer).toBeDefined()

      logBuffer?.push("sentinel-before-restart")
      expect(logBuffer?.getAll()).toContain("sentinel-before-restart")

      await currentSupervisor.restartInstance("alpha")
      await waitForStatus(currentSupervisor, "alpha", "running")
      await waitForLogLine(
        currentSupervisor,
        "alpha",
        "Server started on :9901",
      )

      const lines = currentSupervisor.getLogBuffer("alpha")?.getAll() ?? []

      expect(lines).not.toContain("sentinel-before-restart")
      expect(
        lines.some((line) => line.includes("Server started on :9901")),
      ).toBeTrue()
    })

    test("restartInstance should ignore concurrent restarts for the same instance", async () => {
      const currentSupervisor = createFixtureSupervisor(
        createConfigs([{ name: "alpha", port: 9901 }]),
      )

      const seenStatuses: Array<InstanceStatus> = []
      currentSupervisor.on(
        "status-change",
        (name: unknown, status: unknown) => {
          if (String(name) === "alpha") {
            seenStatuses.push(status as InstanceStatus)
          }
        },
      )

      await currentSupervisor.startAll()
      await waitForStatus(currentSupervisor, "alpha", "running")
      await waitForHealth(9901)

      seenStatuses.length = 0

      await Promise.all([
        currentSupervisor.restartInstance("alpha"),
        currentSupervisor.restartInstance("alpha"),
      ])

      await waitForStatus(currentSupervisor, "alpha", "running")
      await waitForHealth(9901)

      expect(
        seenStatuses.filter((status) => status === "restarting"),
      ).toHaveLength(1)
      expect(seenStatuses.at(-1)).toBe("running")
    })
  })

  describe("stop", () => {
    test("stopAll should mark every instance as stopped", async () => {
      const currentSupervisor = createFixtureSupervisor(
        createConfigs([
          { name: "alpha", port: 9901 },
          { name: "beta", port: 9902 },
        ]),
      )

      await currentSupervisor.startAll()
      await waitForStatus(currentSupervisor, "alpha", "running")
      await waitForStatus(currentSupervisor, "beta", "running")

      await currentSupervisor.stopAll()
      await waitForStatus(currentSupervisor, "alpha", "stopped")
      await waitForStatus(currentSupervisor, "beta", "stopped")

      const state = currentSupervisor.getState()

      expect(state.instances.get("alpha")?.status).toBe("stopped")
      expect(state.instances.get("beta")?.status).toBe("stopped")
      expect(state.instances.get("alpha")?.pid).toBeUndefined()
      expect(state.instances.get("beta")?.pid).toBeUndefined()
    })
  })

  describe("failure", () => {
    test("a child configured with --fail-after 0 should become failed", async () => {
      const currentSupervisor = createFixtureSupervisor(
        createConfigs([
          { name: "crashy", port: 9901, flags: ["--fail-after", "0"] },
        ]),
      )

      await currentSupervisor.startAll()
      await waitForStatus(currentSupervisor, "crashy", "failed")

      const crashyState = currentSupervisor.getState().instances.get("crashy")
      const lines = currentSupervisor.getLogBuffer("crashy")?.getAll() ?? []

      expect(crashyState?.status).toBe("failed")
      expect(lines.some((line) => line.includes("failing after 0s"))).toBeTrue()
    })

    test("one instance failing should not affect healthy siblings", async () => {
      const currentSupervisor = createFixtureSupervisor(
        createConfigs([
          { name: "alpha", port: 9901 },
          { name: "crashy", port: 9902, flags: ["--fail-after", "0"] },
        ]),
      )

      await currentSupervisor.startAll()
      await waitForStatus(currentSupervisor, "crashy", "failed")
      await waitForStatus(currentSupervisor, "alpha", "running")
      await waitForHealth(9901)

      expect(getInstanceState(currentSupervisor, "alpha").status).toBe(
        "running",
      )
      expect(getInstanceState(currentSupervisor, "crashy").status).toBe(
        "failed",
      )
    })
  })

  describe("events", () => {
    test("status changes should emit the instance name and new status", async () => {
      const currentSupervisor = createFixtureSupervisor(
        createConfigs([{ name: "alpha", port: 9901 }]),
      )

      const events: Array<{ name: string; status: InstanceStatus }> = []
      currentSupervisor.on("status-change", (name, status) => {
        events.push({ name: String(name), status: status as InstanceStatus })
      })

      await currentSupervisor.startAll()
      await waitForStatus(currentSupervisor, "alpha", "running")
      await currentSupervisor.stopAll()
      await waitForStatus(currentSupervisor, "alpha", "stopped")

      expect(events).toContainEqual({ name: "alpha", status: "starting" })
      expect(events).toContainEqual({ name: "alpha", status: "running" })
      expect(events).toContainEqual({ name: "alpha", status: "stopped" })
    })
  })

  describe("security", () => {
    test("default command should keep the GitHub token out of argv and pass it via env", () => {
      const [config] = createConfigs([{ name: "alpha", port: 9901 }])
      const currentSupervisor = new Supervisor([config])
      const privateAccess = getPrivateSupervisorAccess(currentSupervisor)

      const command = privateAccess.buildCommand(config)
      const env = privateAccess.buildChildEnv(config)

      expect(command).not.toContain("-g")
      expect(command).not.toContain(config.token)
      expect(env.COPILOT_API_GITHUB_TOKEN).toBe(config.token)
    })

    test("recordLogLine should emit the masked line stored in the buffer", () => {
      const [config] = createConfigs([{ name: "alpha", port: 9901 }])
      const currentSupervisor = new Supervisor([config])
      const privateAccess = getPrivateSupervisorAccess(currentSupervisor)
      const buffer = new LogRingBuffer(5)
      const emitted: Array<string> = []

      currentSupervisor.on("log", (_name, line) => {
        emitted.push(String(line))
      })

      privateAccess.recordLogLine("alpha", "token=ghu_abc123def456", buffer)

      const [storedLine] = buffer.getAll()

      expect(storedLine).toBe(emitted[0])
      expect(storedLine).not.toContain("ghu_abc123def456")
      expect(storedLine).toContain("***")
    })

    test("killOrphan should ignore live processes that are not ours on Linux", async () => {
      if (process.platform === "win32") {
        return
      }

      const [config] = createConfigs([{ name: "alpha", port: 9901 }])
      const currentSupervisor = new Supervisor([config])
      const privateAccess = getPrivateSupervisorAccess(currentSupervisor)
      const unrelatedProc = Bun.spawn(
        ["bun", "-e", "setInterval(() => {}, 1_000)"],
        {
          stdin: "ignore",
          stdout: "ignore",
          stderr: "ignore",
        },
      )

      try {
        await Bun.sleep(100)

        await privateAccess.killOrphan(unrelatedProc.pid)

        expect(isPidAlive(unrelatedProc.pid)).toBeTrue()
      } finally {
        if (isPidAlive(unrelatedProc.pid)) {
          unrelatedProc.kill("SIGKILL")
          await unrelatedProc.exited
        }
      }
    })
  })
})

describe("LogRingBuffer", () => {
  describe("capacity", () => {
    test("should keep only the most recent 500 lines", () => {
      const buffer = new LogRingBuffer()

      for (let index = 1; index <= 600; index += 1) {
        buffer.push(`line-${index}`)
      }

      const lines = buffer.getAll()

      expect(lines).toHaveLength(500)
      expect(lines[0]).toBe("line-101")
      expect(lines.at(-1)).toBe("line-600")
    })
  })

  describe("clear", () => {
    test("should preserve insertion order and clear all lines", () => {
      const buffer = new LogRingBuffer(5)

      buffer.push("alpha", "beta", "gamma")

      expect(buffer.getAll()).toEqual(["alpha", "beta", "gamma"])

      buffer.clear()

      expect(buffer.getAll()).toEqual([])
    })
  })

  describe("masking", () => {
    test("should mask GitHub tokens while leaving normal lines unchanged", () => {
      const buffer = new LogRingBuffer(5)

      buffer.push("token=ghu_abc123def456", "plain log line")

      const lines = buffer.getAll()

      expect(lines[0]).not.toContain("ghu_abc123def456")
      expect(lines[0]).toContain("***")
      expect(lines[1]).toBe("plain log line")
    })
  })
})
