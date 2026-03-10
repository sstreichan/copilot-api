import { readFileSync } from "node:fs"

import { FORBIDDEN_FLAGS, type InstanceConfig } from "~/multi/types"

// Supervisor spawns each instance with:
// ["-p", String(config.port), "-a", config.accountType, "-g", config.token, ...config.flags]

export function parseTokensConfig(filePath: string): Array<InstanceConfig> {
  let content: string

  try {
    content = readFileSync(filePath, "utf8")
  } catch (error) {
    const code =
      error && typeof error === "object" && "code" in error ?
        error.code
      : undefined

    if (code === "ENOENT") {
      throw new Error(`Error: tokens.json not found at: ${filePath}`)
    }

    throw error
  }

  let parsed: unknown

  try {
    parsed = JSON.parse(content) as unknown
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)

    throw new Error(`Error: tokens.json is not valid JSON: ${message}`)
  }

  if (!Array.isArray(parsed)) {
    throw new TypeError("Error: tokens.json must be an array")
  }

  if (parsed.length === 0) {
    throw new Error("Error: tokens.json contains no instances")
  }

  const configs = parsed.map((raw, index) => applyDefaults(raw, index))

  validateConfig(configs)

  return configs
}

export function applyDefaults(raw: unknown, index: number): InstanceConfig {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(
      `Error: Instance at index ${index} is missing required field: name`,
    )
  }

  const record = raw as Record<string, unknown>

  const name = getRequiredName(record, index)
  const port = getRequiredPort(record, index)
  const token = getRequiredToken(record, index)
  const accountType =
    typeof record.accountType === "string" && record.accountType.trim() !== "" ?
      record.accountType
    : "individual"
  const flags =
    Array.isArray(record.flags) ?
      record.flags.filter((flag): flag is string => typeof flag === "string")
    : []

  return {
    name,
    port,
    token,
    accountType,
    flags,
  }
}

export function validateConfig(configs: Array<InstanceConfig>): void {
  const seenNames = new Set<string>()
  const seenPorts = new Set<number>()

  for (const config of configs) {
    if (seenNames.has(config.name)) {
      throw new Error(`Error: Duplicate instance name: "${config.name}"`)
    }

    seenNames.add(config.name)

    if (seenPorts.has(config.port)) {
      throw new Error(`Error: Duplicate port: ${config.port}`)
    }

    seenPorts.add(config.port)

    if (config.token.trim() === "") {
      throw new Error(`Error: Instance "${config.name}" is missing token`)
    }

    for (const flag of config.flags ?? []) {
      if (FORBIDDEN_FLAGS.includes(flag as (typeof FORBIDDEN_FLAGS)[number])) {
        throw new Error(
          `Error: Instance "${config.name}" uses forbidden flag: ${flag}`,
        )
      }
    }
  }
}

function getRequiredName(
  record: Record<string, unknown>,
  index: number,
): string {
  if (typeof record.name !== "string" || record.name.trim() === "") {
    throw new Error(
      `Error: Instance at index ${index} is missing required field: name`,
    )
  }

  return record.name
}

function getRequiredPort(
  record: Record<string, unknown>,
  index: number,
): number {
  if (
    typeof record.port !== "number"
    || !Number.isFinite(record.port)
    || record.port <= 0
  ) {
    throw new Error(
      `Error: Instance at index ${index} is missing required field: port`,
    )
  }

  return record.port
}

function getRequiredToken(
  record: Record<string, unknown>,
  index: number,
): string {
  if (typeof record.token !== "string") {
    throw new TypeError(
      `Error: Instance at index ${index} is missing required field: token`,
    )
  }

  return record.token
}
