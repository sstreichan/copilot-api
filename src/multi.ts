import { defineCommand } from "citty"
import { consola } from "consola"

import type { InstanceProcess } from "~/multi/types"

import { PATHS } from "~/lib/paths"
import { parseTokensConfig as loadTokensConfig } from "~/multi/config"
import { Supervisor } from "~/multi/supervisor"
import { createTui, type TuiHandle } from "~/multi/tui"

export default defineCommand({
  meta: {
    name: "multi",
    description: "Run multiple copilot-api instances with a TUI dashboard",
  },
  args: {
    config: {
      type: "string",
      alias: "c",
      description: "Path to tokens.json config file",
      default: PATHS.TOKENS_PATH,
    },
    verbose: {
      type: "boolean",
      alias: "v",
      description: "Enable verbose logging",
      default: false,
    },
  },
  async run({ args }) {
    // Check TTY — multi requires a terminal
    if (!process.stdout.isTTY) {
      consola.error(
        "Error: 'multi' command requires a TTY terminal. Pipe output not supported.",
      )
      process.exit(1)
    }

    let configs
    try {
      configs = loadTokensConfig(args.config)
    } catch (error) {
      consola.error(error instanceof Error ? error.message : String(error))
      process.exit(1)
    }

    const supervisor = new Supervisor(configs)
    const getInstances = (): Array<InstanceProcess> => [
      ...supervisor.getState().instances.values(),
    ]

    let shuttingDown = false
    let tui: TuiHandle | undefined

    try {
      tui = await createTui(getInstances(), {
        onRestart: (name) => {
          void supervisor.restartInstance(name)
        },
        onQuit: () => {
          void shutdown(0)
        },
        supervisor,
      })
    } catch (error) {
      consola.error(error instanceof Error ? error.message : String(error))
      await supervisor.stopAll()
      process.exit(1)
    }

    const refreshTui = () => {
      if (shuttingDown) {
        return
      }

      tui.update(getInstances())
    }

    supervisor.on("status-change", refreshTui)
    supervisor.on("log", refreshTui)

    async function shutdown(exitCode: number): Promise<void> {
      if (shuttingDown) {
        return
      }

      shuttingDown = true

      let shutdownError: unknown

      try {
        tui?.destroy()
      } catch (error) {
        shutdownError = error
      }

      try {
        await supervisor.stopAll()
      } catch (error) {
        shutdownError ??= error
      }

      if (shutdownError) {
        consola.error(shutdownError)
      }

      process.exit(exitCode)
    }

    const handleSignal = () => {
      void shutdown(0)
    }
    const handleUncaughtException = (error: Error) => {
      consola.error(error)
      void shutdown(1)
    }
    const handleUnhandledRejection = (reason: unknown) => {
      consola.error(reason)
      void shutdown(1)
    }

    process.on("SIGINT", handleSignal)
    process.on("SIGTERM", handleSignal)
    process.on("uncaughtException", handleUncaughtException)
    process.on("unhandledRejection", handleUnhandledRejection)

    try {
      await supervisor.startAll()
    } catch (error) {
      consola.error(error instanceof Error ? error.message : String(error))
      await shutdown(1)
    }
  },
})
