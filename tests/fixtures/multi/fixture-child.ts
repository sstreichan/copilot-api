#!/usr/bin/env bun
// Standalone fixture — no imports from src/

// Parse CLI args
const args = process.argv.slice(2)
const portIdx = args.indexOf("--port")
const nameIdx = args.indexOf("--name")
const failAfterIdx = args.indexOf("--fail-after")

if (portIdx === -1 || nameIdx === -1) {
  console.error(
    "Usage: fixture-child.ts --port <port> --name <name> [--fail-after <seconds>]",
  )
  process.exit(1)
}

const port = Number.parseInt(args[portIdx + 1], 10)
const name = args[nameIdx + 1]
const failAfter =
  failAfterIdx !== -1 ? Number.parseInt(args[failAfterIdx + 1], 10) : null

if (Number.isNaN(port) || port <= 0) {
  console.error(`Invalid port: ${args[portIdx + 1]}`)
  process.exit(1)
}

// Start HTTP server
const server = Bun.serve({
  port,
  fetch(req) {
    const url = new URL(req.url)
    if (url.pathname === "/health") {
      return Response.json({ status: "ok", name, port })
    }
    return new Response("Not Found", { status: 404 })
  },
})

console.log(`[${name}] Server started on :${port}`)

// Heartbeat
const heartbeat = setInterval(() => {
  console.log(`[${name}] heartbeat`)
}, 2000)

// Clean shutdown
function shutdown() {
  console.log(`[${name}] shutting down`)
  clearInterval(heartbeat)
  void server.stop()
  process.exit(0)
}

process.on("SIGTERM", shutdown)
process.on("SIGINT", shutdown)

// --fail-after: exit with error after N seconds
if (failAfter !== null) {
  setTimeout(() => {
    console.error(`[${name}] failing after ${failAfter}s`)
    clearInterval(heartbeat)
    void server.stop()
    process.exit(1)
  }, failAfter * 1000)
}
