import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { existsSync, rmSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

import {
  getMachineId,
  SESSION_ID,
  getCommonProperties,
  getDevDeviceId,
} from "../src/services/telemetry/identity"

describe("telemetry identity", () => {
  const testDeviceIdPath = join(
    homedir(),
    ".cache",
    "Microsoft",
    "DeveloperTools",
    "deviceid",
  )

  beforeEach(() => {
    // Clean up test device ID file before each test
    if (existsSync(testDeviceIdPath)) {
      rmSync(testDeviceIdPath, { force: true })
    }
  })

  afterEach(() => {
    // Clean up after tests
    if (existsSync(testDeviceIdPath)) {
      rmSync(testDeviceIdPath, { force: true })
    }
  })

  it("getMachineId returns 64-char hex string", () => {
    const machineId = getMachineId()

    expect(machineId).toBeString()
    expect(machineId.length).toBe(64)
    expect(/^[0-9a-f]{64}$/.test(machineId)).toBe(true)
  })

  it("getMachineId is deterministic (same result on multiple calls)", () => {
    const machineId1 = getMachineId()
    const machineId2 = getMachineId()

    expect(machineId1).toBe(machineId2)
  })

  it("SESSION_ID is valid UUID format", () => {
    // UUID v4 format: xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx
    const uuidRegex =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

    expect(SESSION_ID).toMatch(uuidRegex)
  })

  it("getCommonProperties returns expected keys", () => {
    const machineId = getMachineId()
    const props = getCommonProperties({
      machineId,
      sessionId: SESSION_ID,
      vsCodeVersion: "1.85.0",
    })

    const expectedKeys = [
      "common_vscodemachineid",
      "common_vscodesessionid",
      "client_machineid",
      "client_deviceid",
      "common_os",
      "common_platformversion",
      "common_arch",
      "common_extname",
      "common_extversion",
      "common_vscodeversion",
      "common_uikind",
      "common_editorsession_id",
    ]

    for (const key of expectedKeys) {
      expect(key in props).toBe(true)
      expect(props[key]).toBeString()
      expect(props[key].length).toBeGreaterThan(0)
    }
  })

  it("getDevDeviceId returns UUID format", () => {
    const deviceId = getDevDeviceId()
    const uuidRegex =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

    expect(deviceId).toMatch(uuidRegex)
  })

  it("getDevDeviceId persists and retrieves same ID", () => {
    const deviceId1 = getDevDeviceId()
    const deviceId2 = getDevDeviceId()

    expect(deviceId1).toBe(deviceId2)

    // Verify it was written to file
    const content = readFileSync(testDeviceIdPath, "utf8").trim()
    expect(content).toBe(deviceId1)
  })
})
