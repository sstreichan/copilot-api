import type { Context } from "hono"

const STRIPPED_RESPONSE_HEADERS = [
  "connection",
  "content-encoding",
  "content-length",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
] as const

const responseHeadersSymbol = Symbol("responseHeaders")

export const attachResponseHeaders = <T extends object>(
  value: T,
  headers: Headers,
): T => {
  Object.defineProperty(value, responseHeadersSymbol, {
    value: new Headers(headers),
    enumerable: false,
    configurable: true,
  })

  return value
}

export const getAttachedResponseHeaders = (value: unknown): Headers | null => {
  if (!value || (typeof value !== "object" && typeof value !== "function")) {
    return null
  }

  const headers = (value as Record<symbol, Headers | undefined>)[
    responseHeadersSymbol
  ]

  return headers ? new Headers(headers) : null
}

export const cloneForwardableResponseHeaders = (
  sourceHeaders?: Headers | null,
  overrides: Record<string, string | null | undefined> = {},
): Headers => {
  const headers = new Headers(sourceHeaders ?? undefined)

  for (const headerName of STRIPPED_RESPONSE_HEADERS) {
    headers.delete(headerName)
  }

  for (const [name, value] of Object.entries(overrides)) {
    if (value === null || value === undefined) {
      headers.delete(name)
    } else {
      headers.set(name, value)
    }
  }

  return headers
}

export const applyForwardableResponseHeaders = (
  c: Context,
  sourceHeaders?: Headers | null,
  overrides: Record<string, string | null | undefined> = {},
): void => {
  const headers = cloneForwardableResponseHeaders(sourceHeaders, overrides)

  for (const [name, value] of headers) {
    c.header(name, value)
  }
}

export const jsonWithForwardedHeaders = (
  body: unknown,
  sourceHeaders?: Headers | null,
  init: {
    status?: number
    overrides?: Record<string, string | null | undefined>
  } = {},
): Response => {
  const headers = cloneForwardableResponseHeaders(sourceHeaders, {
    ...init.overrides,
    "content-type": "application/json; charset=utf-8",
  })

  return new Response(JSON.stringify(body), {
    headers,
    status: init.status ?? 200,
  })
}
