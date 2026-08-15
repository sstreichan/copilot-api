const TLS_CERTIFICATE_VERIFICATION_ERROR =
  "unknown certificate verification error"
const TLS_RETRY_DELAY_MS = 200

export const isTlsCertificateVerificationFailure = (error: unknown): boolean =>
  error instanceof Error
  && error.message.includes(TLS_CERTIFICATE_VERIFICATION_ERROR)

const waitForRetryDelay = (signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    const rejectWithAbortReason = () => {
      const error = new Error("The operation was aborted")
      error.name = "AbortError"
      reject(error)
    }

    if (signal?.aborted) {
      rejectWithAbortReason()
      return
    }

    const timeout = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort)
      resolve()
    }, TLS_RETRY_DELAY_MS)
    const onAbort = () => {
      clearTimeout(timeout)
      signal?.removeEventListener("abort", onAbort)
      rejectWithAbortReason()
    }

    signal?.addEventListener("abort", onAbort, { once: true })
  })

export const retryAfterTlsCertificateVerificationFailure = async <T>(
  request: () => Promise<T>,
  options: { signal?: AbortSignal } = {},
): Promise<T> => {
  try {
    return await request()
  } catch (error) {
    if (!isTlsCertificateVerificationFailure(error)) {
      throw error
    }

    await waitForRetryDelay(options.signal)
    return request()
  }
}
