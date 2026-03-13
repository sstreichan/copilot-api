import { afterEach, describe, expect, test } from "bun:test"
import { join } from "node:path"

import type { InstanceConfig, InstanceStatus } from "~/multi/types"

import { parseTokensConfig } from "~/multi/config"
import { Supervisor } from "~/multi/supervisor"

const FIXTURE_DIR = join(import.meta.dir, "../fixtures/multi")
const FIXTURE_CHILD_PATH = join(FIXTURE_DIR, "fixture-child.ts")
const VALID_TOKENS_PATH = join(FIXTURE_DIR, "valid-tokens.json")
const DUPLICATE_PORT_PATH = join(
  FIXTURE_DIR,
  "tokens-invalid-duplicate-port.json",
)
const DUPLICATE_NAME_PATH = join(
  FIXTURE_DIR,
  "tokens-invalid-duplicate-name.json",
)

const WAIT_TIMEOUT_MS = 8_000
const POLL_INTERVAL_MS = 50

let supervisor: Supervisor | undefined

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

function createFixtureSupervisor(configs: Array<InstanceConfig>): Supervisor {
  const s = new Supervisor(configs)
  s.setCommandBuilder((config) => [
    "bun",
    FIXTURE_CHILD_PATH,
    "--port",
    String(config.port),
    "--name",
    config.name,
    ...(config.flags ?? []),
  ])
  supervisor = s
  return s
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

describe("parseTokensConfig -> Supervisor integration", () => {
  test("pipeline-instance-count", () => {
    const configs = parseTokensConfig(VALID_TOKENS_PATH)
    const currentSupervisor = createFixtureSupervisor(configs)
    const state = currentSupervisor.getState()

    expect(state.instances.size).toBe(2)
    expect([...state.instances.keys()]).toEqual([
      "integration-test-1",
      "integration-test-2",
    ])
  })

  test("pipeline-start-pids", async () => {
    const currentSupervisor = createFixtureSupervisor(
      parseTokensConfig(VALID_TOKENS_PATH),
    )

    await currentSupervisor.startAll()
    await waitForStatus(currentSupervisor, "integration-test-1", "running")
    await waitForStatus(currentSupervisor, "integration-test-2", "running")
    await waitForHealth(59100)
    await waitForHealth(59101)

    const state = currentSupervisor.getState()

    expect(state.instances.get("integration-test-1")?.pid).toBeDefined()
    expect(state.instances.get("integration-test-2")?.pid).toBeDefined()
    expect(state.instances.get("integration-test-1")?.pid).toBeGreaterThan(0)
    expect(state.instances.get("integration-test-2")?.pid).toBeGreaterThan(0)
  }, 10_000)

  test("pipeline-stop", async () => {
    const currentSupervisor = createFixtureSupervisor(
      parseTokensConfig(VALID_TOKENS_PATH),
    )

    await currentSupervisor.startAll()
    await waitForStatus(currentSupervisor, "integration-test-1", "running")
    await waitForStatus(currentSupervisor, "integration-test-2", "running")

    await currentSupervisor.stopAll()
    await waitForStatus(currentSupervisor, "integration-test-1", "stopped")
    await waitForStatus(currentSupervisor, "integration-test-2", "stopped")

    const state = currentSupervisor.getState()

    expect(state.instances.get("integration-test-1")?.pid).toBeUndefined()
    expect(state.instances.get("integration-test-2")?.pid).toBeUndefined()
  }, 10_000)

  test("pipeline-restart", async () => {
    const currentSupervisor = createFixtureSupervisor(
      parseTokensConfig(VALID_TOKENS_PATH),
    )

    await currentSupervisor.startAll()
    await waitForStatus(currentSupervisor, "integration-test-1", "running")
    await waitForStatus(currentSupervisor, "integration-test-2", "running")
    await waitForHealth(59100)
    await waitForHealth(59101)

    const pidBefore = getInstanceState(
      currentSupervisor,
      "integration-test-1",
    ).pid
    const siblingPidBefore = getInstanceState(
      currentSupervisor,
      "integration-test-2",
    ).pid

    await currentSupervisor.restartInstance("integration-test-1")
    await waitForStatus(currentSupervisor, "integration-test-1", "running")
    await waitForHealth(59100)
    await waitForHealth(59101)

    const pidAfter = getInstanceState(
      currentSupervisor,
      "integration-test-1",
    ).pid
    const siblingPidAfter = getInstanceState(
      currentSupervisor,
      "integration-test-2",
    ).pid

    expect(pidBefore).toBeDefined()
    expect(pidAfter).toBeDefined()
    expect(pidAfter).not.toBe(pidBefore)
    expect(siblingPidAfter).toBe(siblingPidBefore)
  }, 10_000)

  test("pipeline-status", async () => {
    const currentSupervisor = createFixtureSupervisor(
      parseTokensConfig(VALID_TOKENS_PATH),
    )

    await currentSupervisor.startAll()
    await waitForStatus(currentSupervisor, "integration-test-1", "running")
    await waitForStatus(currentSupervisor, "integration-test-2", "running")

    const state = currentSupervisor.getState()

    expect(state.instances.get("integration-test-1")?.status).toBe("running")
    expect(state.instances.get("integration-test-2")?.status).toBe("running")
  }, 10_000)

  test("config-invalid-path", () => {
    expect(() => parseTokensConfig("/nonexistent/path/tokens.json")).toThrow(
      /not found/,
    )
  })

  test("config-duplicate-ports", () => {
    expect(() => parseTokensConfig(DUPLICATE_PORT_PATH)).toThrow(
      /Duplicate port/,
    )
  })

  test("config-duplicate-names", () => {
    expect(() => parseTokensConfig(DUPLICATE_NAME_PATH)).toThrow(
      /Duplicate instance name/,
    )
  })
})
