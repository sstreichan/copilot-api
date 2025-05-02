import consola from "consola"

import { getCopilotChatVersions } from "~/services/get-CopilotChat-version"

import { state } from "./state"

export const cacheCopilotChatVersion = async () => {
  try {
    const versions = await getCopilotChatVersions()
    if (versions.length > 0) {
      state.copilotChatVersion = versions[0].version
    } else {
      consola.warn("No Copilot Chat versions found, using fallback.")
    }
  } catch (error) {
    consola.error(
      "Failed to fetch Copilot Chat versions, using fallback:",
      error,
    )
  }
  consola.info(`Using CopilotChat version: ${state.copilotChatVersion}`)
}
