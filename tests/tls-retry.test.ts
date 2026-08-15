import { expect, mock, test } from "bun:test"

import { retryAfterTlsCertificateVerificationFailure } from "../src/services/tls-retry"

const tlsError = () => new Error("unknown certificate verification error")

test("retries once after certificate verification failure", async () => {
  const request = mock(() =>
    request.mock.calls.length === 1 ?
      Promise.reject(tlsError())
    : Promise.resolve("ok"),
  )

  expect(await retryAfterTlsCertificateVerificationFailure(request)).toBe("ok")
  expect(request).toHaveBeenCalledTimes(2)
})

test("does not retry unrelated failures", async () => {
  const request = mock(() => Promise.reject(new Error("socket hang up")))

  await expectRejected(
    retryAfterTlsCertificateVerificationFailure(request),
    "socket hang up",
  )
  expect(request).toHaveBeenCalledTimes(1)
})

test("does not retry after abort during retry delay", async () => {
  const controller = new AbortController()
  const request = mock(() => Promise.reject(tlsError()))
  const result = retryAfterTlsCertificateVerificationFailure(request, {
    signal: controller.signal,
  })

  controller.abort()

  await expectRejected(result, "The operation was aborted")
  expect(request).toHaveBeenCalledTimes(1)
})

test("does not retry more than once", async () => {
  const request = mock(() => Promise.reject(tlsError()))

  await expectRejected(
    retryAfterTlsCertificateVerificationFailure(request),
    "unknown certificate verification error",
  )
  expect(request).toHaveBeenCalledTimes(2)
})

const expectRejected = async (
  promise: Promise<unknown>,
  message: string,
): Promise<void> => {
  try {
    await promise
  } catch (error) {
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toContain(message)
    return
  }

  throw new Error("Expected promise to reject")
}
