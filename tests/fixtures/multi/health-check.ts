import { request } from "node:http"

export async function isHealthEndpointReady(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false

    function finish(result: boolean) {
      if (settled) {
        return
      }

      settled = true
      resolve(result)
    }

    const req = request(
      {
        host: "127.0.0.1",
        method: "GET",
        path: "/health",
        port,
      },
      (response) => {
        if (response.statusCode !== 200) {
          response.resume()
          finish(false)
          return
        }

        let body = ""
        response.setEncoding("utf8")
        response.on("data", (chunk: string) => {
          body += chunk
        })
        response.on("end", () => {
          try {
            const payload = JSON.parse(body) as {
              status?: string
              port?: number
            }

            finish(payload.status === "ok" && payload.port === port)
          } catch {
            finish(false)
          }
        })
        response.on("error", () => {
          finish(false)
        })
      },
    )

    req.setTimeout(1_000, () => {
      req.destroy()
      finish(false)
    })
    req.on("error", () => {
      finish(false)
    })
    req.end()
  })
}
