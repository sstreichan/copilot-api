import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"

import { runServer } from "../src/start"

const callOrder: Array<string> = []

describe("runServer auto-session prewarm order", () => {
  beforeEach(async () => {
    callOrder.length = 0

    await mock.module("../src/lib/utils", () => ({
      cacheModels: () => {
        callOrder.push("cacheModels")
        return Promise.resolve()
      },
      cacheVSCodeVersion: async () => {},
      cacheMacMachineId: () => {},
      cacheVsCodeSessionId: () => {},
      cacheVsCodeDeviceId: async () => {},
    }))

    await mock.module("../src/lib/auto-session", () => ({
      prewarmAutoSession: () => {
        callOrder.push("prewarmAutoSession")
        return Promise.resolve()
      },
    }))

    await mock.module("../src/lib/config", () => ({
      mergeConfigWithDefaults: () => {},
    }))

    await mock.module("../src/lib/opencode", () => ({
      initOpencodeVersion: async () => {},
    }))

    await mock.module("../src/lib/paths", () => ({
      ensurePaths: async () => {},
    }))

    await mock.module("../src/lib/token", () => ({
      setupGitHubToken: async () => {},
      setupCopilotToken: async () => {},
      logUser: async () => {},
    }))

    await mock.module("../src/lib/models-log", () => ({
      formatModelsLog: () => "models",
    }))

    await mock.module("../src/lib/proxy", () => ({
      initProxyFromEnv: () => {},
    }))

    await mock.module("srvx", () => ({
      serve: () => {},
    }))
  })

  afterEach(() => {
    mock.restore()
  })

  test("runs prewarmAutoSession after cacheModels", async () => {
    await runServer({
      port: 4141,
      verbose: false,
      accountType: "individual",
      manual: false,
      rateLimit: undefined,
      rateLimitWait: false,
      githubToken: "provided-token",
      claudeCode: false,
      showToken: false,
      proxyEnv: false,
      forceAgent: false,
      nativeMessages: false,
    })

    expect(callOrder).toEqual(["cacheModels", "prewarmAutoSession"])
  })
})
