import { test, expect } from "bun:test"
import path from "node:path"

import {
  parseTokensConfig,
  applyDefaults,
  validateConfig,
} from "~/multi/config"
import { FORBIDDEN_FLAGS } from "~/multi/types"

const fixtureDir = path.join(import.meta.dir, "../fixtures/multi")

// ============================================================================
// parseTokensConfig Tests
// ============================================================================

test("parseTokensConfig: should parse valid tokens.json with 3 instances", () => {
  const configPath = path.join(fixtureDir, "tokens-valid.json")
  const result = parseTokensConfig(configPath)

  expect(result).toHaveLength(3)
  expect(result[0].name).toBe("personal")
  expect(result[0].port).toBe(4141)
  expect(result[0].token).toBe("ghu_test_personal_token_12345")
  expect(result[0].accountType).toBe("individual")
  expect(result[0].flags).toEqual(["-M", "-v"])

  expect(result[1].name).toBe("company")
  expect(result[1].accountType).toBe("business")
  expect(result[1].flags).toEqual(["-M", "-F"])

  expect(result[2].name).toBe("xianyu")
  expect(result[2].accountType).toBe("individual")
  expect(result[2].flags).toEqual([])
})

test("parseTokensConfig: should apply defaults to legacy tokens.json (no accountType/flags)", () => {
  const configPath = path.join(fixtureDir, "tokens-legacy.json")
  const result = parseTokensConfig(configPath)

  expect(result).toHaveLength(3)
  // Legacy entries default to accountType="individual" and flags=[]
  expect(result[0].accountType).toBe("individual")
  expect(result[0].flags).toEqual([])
  expect(result[1].accountType).toBe("individual")
  expect(result[1].flags).toEqual([])
})

test("parseTokensConfig: should throw for empty array in tokens.json", () => {
  const configPath = path.join(fixtureDir, "tokens-empty.json")

  expect(() => parseTokensConfig(configPath)).toThrow("no instances")
})

test("parseTokensConfig: should throw for malformed JSON", () => {
  const configPath = path.join(fixtureDir, "tokens-malformed.json")

  expect(() => parseTokensConfig(configPath)).toThrow("not valid JSON")
})

test("parseTokensConfig: should throw when file not found", () => {
  const configPath = path.join(fixtureDir, "nonexistent.json")

  expect(() => parseTokensConfig(configPath)).toThrow("not found at")
})

// ============================================================================
// validateConfig Tests - Validation Errors
// ============================================================================

test("validateConfig: should throw for duplicate port", () => {
  const configPath = path.join(fixtureDir, "tokens-invalid-duplicate-port.json")

  expect(() => parseTokensConfig(configPath)).toThrow("Duplicate port")
})

test("validateConfig: should throw for duplicate name", () => {
  const configPath = path.join(fixtureDir, "tokens-invalid-duplicate-name.json")

  expect(() => parseTokensConfig(configPath)).toThrow("Duplicate instance name")
})

test("validateConfig: should throw for missing token (empty string)", () => {
  const configPath = path.join(fixtureDir, "tokens-invalid-missing-token.json")

  expect(() => parseTokensConfig(configPath)).toThrow("missing token")
})

test("validateConfig: should throw for forbidden flag", () => {
  const configPath = path.join(fixtureDir, "tokens-invalid-forbidden-flag.json")

  expect(() => parseTokensConfig(configPath)).toThrow("forbidden flag")
})

// ============================================================================
// applyDefaults Tests
// ============================================================================

test("applyDefaults: should apply defaults to minimal config (accountType + flags)", () => {
  const raw = {
    name: "test",
    port: 4141,
    token: "ghu_test_token",
  }

  const result = applyDefaults(raw, 0)

  expect(result.name).toBe("test")
  expect(result.port).toBe(4141)
  expect(result.token).toBe("ghu_test_token")
  expect(result.accountType).toBe("individual")
  expect(result.flags).toEqual([])
})

test("applyDefaults: should preserve explicit accountType and flags", () => {
  const raw = {
    name: "test",
    port: 4141,
    token: "ghu_test_token",
    accountType: "business",
    flags: ["-M", "-v"],
  }

  const result = applyDefaults(raw, 0)

  expect(result.accountType).toBe("business")
  expect(result.flags).toEqual(["-M", "-v"])
})

test("applyDefaults: should filter out non-string flags", () => {
  const raw = {
    name: "test",
    port: 4141,
    token: "ghu_test_token",
    flags: ["-M", 123, "-v", null, undefined],
  }

  const result = applyDefaults(raw, 0)

  expect(result.flags).toEqual(["-M", "-v"])
})

test("applyDefaults: should default accountType to individual when empty string", () => {
  const raw = {
    name: "test",
    port: 4141,
    token: "ghu_test_token",
    accountType: "",
  }

  const result = applyDefaults(raw, 0)

  expect(result.accountType).toBe("individual")
})

test("applyDefaults: should discard unknown fields silently", () => {
  const raw = {
    name: "test",
    port: 4141,
    token: "ghu_test_token",
    extraField: "should be ignored",
    anotherField: 123,
  }

  const result = applyDefaults(raw, 0)

  expect(result).toEqual({
    name: "test",
    port: 4141,
    token: "ghu_test_token",
    accountType: "individual",
    flags: [],
  })
  expect("extraField" in result).toBe(false)
  expect("anotherField" in result).toBe(false)
})

test("applyDefaults: should throw for missing name", () => {
  const raw = {
    port: 4141,
    token: "ghu_test_token",
  }

  expect(() => applyDefaults(raw, 0)).toThrow("missing required field: name")
})

test("applyDefaults: should throw for missing port", () => {
  const raw = {
    name: "test",
    token: "ghu_test_token",
  }

  expect(() => applyDefaults(raw, 0)).toThrow("missing required field: port")
})

test("applyDefaults: should throw for invalid port (negative)", () => {
  const raw = {
    name: "test",
    port: -1,
    token: "ghu_test_token",
  }

  expect(() => applyDefaults(raw, 0)).toThrow("missing required field: port")
})

test("applyDefaults: should throw for missing token", () => {
  const raw = {
    name: "test",
    port: 4141,
  }

  expect(() => applyDefaults(raw, 0)).toThrow("missing required field: token")
})

// ============================================================================
// Integration Tests - Full Parsing
// ============================================================================

test("integration: parseTokensConfig should correctly handle valid JSON with all fields", () => {
  const configPath = path.join(fixtureDir, "tokens-valid.json")
  const result = parseTokensConfig(configPath)

  // Verify structure
  expect(result).toBeDefined()
  expect(Array.isArray(result)).toBe(true)

  // Verify all instances have required fields
  for (const config of result) {
    expect(config.name).toBeDefined()
    expect(typeof config.name).toBe("string")
    expect(config.port).toBeDefined()
    expect(typeof config.port).toBe("number")
    expect(config.token).toBeDefined()
    expect(typeof config.token).toBe("string")
    expect(config.accountType).toBeDefined()
    expect(typeof config.accountType).toBe("string")
    expect(config.flags).toBeDefined()
    expect(Array.isArray(config.flags)).toBe(true)
  }
})

test("integration: tokens should be non-empty after validation", () => {
  const validConfigPath = path.join(fixtureDir, "tokens-valid.json")
  const result = parseTokensConfig(validConfigPath)

  for (const config of result) {
    expect(config.token.trim().length).toBeGreaterThan(0)
  }
})

test("integration: all ports should be unique after validation", () => {
  const validConfigPath = path.join(fixtureDir, "tokens-valid.json")
  const result = parseTokensConfig(validConfigPath)

  const ports = result.map((c) => c.port)
  const uniquePorts = new Set(ports)

  expect(uniquePorts.size).toBe(ports.length)
})

test("integration: all names should be unique after validation", () => {
  const validConfigPath = path.join(fixtureDir, "tokens-valid.json")
  const result = parseTokensConfig(validConfigPath)

  const names = result.map((c) => c.name)
  const uniqueNames = new Set(names)

  expect(uniqueNames.size).toBe(names.length)
})

// ============================================================================
// FORBIDDEN_FLAGS Tests
// ============================================================================

test("FORBIDDEN_FLAGS: should include --manual, --claude-code, --show-token", () => {
  expect(FORBIDDEN_FLAGS).toContain("--manual")
  expect(FORBIDDEN_FLAGS).toContain("--claude-code")
  expect(FORBIDDEN_FLAGS).toContain("--show-token")
})

test("FORBIDDEN_FLAGS: should reject instance with --manual flag", () => {
  const raw = {
    name: "bad",
    port: 4141,
    token: "ghu_test_token",
    flags: ["--manual"],
  }

  const config = applyDefaults(raw, 0)

  expect(() => validateConfig([config])).toThrow("forbidden flag")
})

test("FORBIDDEN_FLAGS: should reject instance with --claude-code flag", () => {
  const raw = {
    name: "bad",
    port: 4141,
    token: "ghu_test_token",
    flags: ["--claude-code"],
  }

  const config = applyDefaults(raw, 0)

  expect(() => validateConfig([config])).toThrow("forbidden flag")
})

test("FORBIDDEN_FLAGS: should accept allowed flags like -M, -F, -v", () => {
  const raw = {
    name: "good",
    port: 4141,
    token: "ghu_test_token",
    flags: ["-M", "-F", "-v"],
  }

  const config = applyDefaults(raw, 0)

  // Should not throw
  expect(() => validateConfig([config])).not.toThrow()
})
