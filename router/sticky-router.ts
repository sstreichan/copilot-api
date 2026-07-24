import { readFileSync, appendFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

import { readPort, parseInstances } from "./lib"
import {
  DEFAULT_INSTANCE_COOLDOWN_MS,
  createDashboardHandler,
  createRouterHandler,
  createStickyRouterState,
  discoverModels,
  prefetchPremiumUsage,
} from "./state"

const ROUTER_PORT = readPort("ROUTER_PORT", 4140)
const DASHBOARD_PORT = readPort("DASHBOARD_PORT", 4139)
const TOKENS_PATH =
  process.env.TOKENS_PATH
  || join(homedir(), ".local/share/copilot-api/tokens.json")
const LOG_FILE = process.env.STICKY_ROUTER_LOG_FILE || "/tmp/sticky-router.log"
const DEFAULT_COOLDOWN_MS =
  readPort(
    "ROUTER_DEFAULT_COOLDOWN_SECONDS",
    DEFAULT_INSTANCE_COOLDOWN_MS / 1000,
  ) * 1000
const MAX_LINES = 200
const TRIM_TO = 150
const DASHBOARD_FILE = Bun.file(new URL("./dashboard.html", import.meta.url))

function log(line: string) {
  const entry = `[${new Date().toISOString()}] ${line}\n`
  appendFileSync(LOG_FILE, entry)
  console.log(line)
  try {
    const lines = readFileSync(LOG_FILE, "utf8").split("\n").filter(Boolean)
    if (lines.length > MAX_LINES) {
      writeFileSync(LOG_FILE, lines.slice(-TRIM_TO).join("\n") + "\n")
    }
  } catch {
    return
  }
}

export async function main() {
  const rawInstances: unknown = JSON.parse(readFileSync(TOKENS_PATH, "utf8"))
  const instances = parseInstances(rawInstances)
  const state = createStickyRouterState(instances)

  await discoverModels(state, log)

  Bun.serve({
    idleTimeout: 0,
    port: ROUTER_PORT,
    fetch: createRouterHandler({
      state,
      logger: log,
      defaultCooldownMs: DEFAULT_COOLDOWN_MS,
    }),
  })

  Bun.serve({
    idleTimeout: 0,
    port: DASHBOARD_PORT,
    fetch: createDashboardHandler({
      state,
      logger: log,
      dashboardFile: DASHBOARD_FILE,
    }),
  })

  // ponytail: prefetch runs in background so dashboard/router come up immediately;
  // slow or failing /usage on any instance must not block 4139 from serving
  void prefetchPremiumUsage(state, log)

  log(
    `router started on :${ROUTER_PORT}, ${state.instances.length} instances: ${state.instances.map((instance) => `${instance.name}:${instance.port}`).join(", ")}`,
  )
  console.log(
    `\n  Sticky router listening on http://localhost:${ROUTER_PORT}\n  Dashboard listening on http://localhost:${DASHBOARD_PORT}\n`,
  )
}

if (import.meta.main) {
  await main()
}
