// fetch is globally available in Node.js v18+

interface VersionInfo {
  version: string
  flags: number
}

// Define a more specific type for the expected API response
interface ExtensionQueryResponse {
  results: Array<{
    extensions: Array<{
      versions: Array<VersionInfo>
    }>
  }>
}

/**
 * Fetches and returns a list of *stable* Copilot Chat versions, sorted newest first.
 * (Versions with suffixes like 1.2.3-preview will be filtered out.)
 */
export async function getCopilotChatVersions(): Promise<Array<VersionInfo>> {
  try {
    const response = await fetch(
      "https://marketplace.visualstudio.com/_apis/public/gallery/extensionquery",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          //Accept: "application/json;api-version=7.1-preview.1;excludeUrls=true",
          Accept: "application/json;api-version=3.0-preview.1",
        },
        body: JSON.stringify({
          filters: [
            {
              criteria: [{ filterType: 7, value: "GitHub.copilot-chat" }],
              pageNumber: 1,
              pageSize: 0,
              sortBy: 4, // sort by last updated
              sortOrder: 0, // descending
            },
          ],
          flags: 55,
        }),
      },
    )

    if (!response.ok) {
      console.error(
        `Error fetching versions: ${response.status} ${response.statusText}`,
      )
      return []
    }

    const data = (await response.json()) as ExtensionQueryResponse
    const versions = data.results[0]?.extensions?.[0]?.versions ?? []
    if (versions.length === 0) {
      console.error("No versions found in the marketplace response.")
      return []
    }

    // Keep only strict SemVer (no suffixes) to get the latest stable version.
    const stableVersions = versions.filter((v) =>
      /^\d+\.\d{1,2}\.\d{1,2}$/.test(v.version),
    )
    if (stableVersions.length === 0) {
      console.warn("No stable versions found in the marketplace response.")
    }

    return stableVersions
  } catch (error) {
    console.error("Error fetching Copilot Chat versions:", error)
    return []
  }
}
