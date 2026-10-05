import type { ApiClient } from "@/lib/api/client"
import { ApiError } from "@/lib/api/errors"
import type { Submission } from "@/lib/submissions"

// What became of a wrap that was sent and not seen through.
// - confirmed: it landed. The wrapped amount is pending until it is applied.
// - failed: the network dropped it, or its blockhash ran out with no way to
//   land. Nothing was taken, so depositing again is safe.
// - unknown: it may or may not have landed and cannot be told from here (no
//   signature came back, or the service no longer has the record).
export type Reconciled = "confirmed" | "failed" | "unknown"

// A blockhash lives about 150 blocks (up to ~90 s), and the chain read can lag by
// about 13 s, so nothing is called expired before this long after it was sent.
export const EXPIRY_MS = 90_000

type Input = {
  // What the check reads of a record: withdrawals and payroll payments keep their own
  // shapes and pass just these three.
  record: Pick<Submission, "request_id" | "signature" | "at">
  // Only the confirm call is used, so another transaction's confirm can stand in.
  api: { wrap: Pick<ApiClient["wrap"], "confirm"> }
  signal?: AbortSignal
  now?: () => number
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
  pollMs?: number
}

export const wait = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason)
    const onAbort = () => {
      clearTimeout(timer)
      reject(signal?.reason)
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort)
      resolve()
    }, ms)
    signal?.addEventListener("abort", onAbort, { once: true })
  })

// Asks the service about a recorded wrap until it is answered for good. The
// confirm call is idempotent (the same signature returns the same receipt), so
// asking again is safe. A 404 is not an answer: WRAP_API.md says unsigned
// records are collected after their blockhash expires and 24 hours, and that a
// later 404 is not evidence the deposit failed, so it reads as unknown.
export async function reconcileWrap({
  record,
  api,
  signal,
  now = Date.now,
  sleep = wait,
  pollMs = 3_000,
}: Input): Promise<Reconciled> {
  // Whether the service ever answered that the transaction is not on the chain.
  // A service that could not be reached says nothing about it.
  let notOnChain = false
  for (;;) {
    signal?.throwIfAborted()
    let pause = pollMs
    if (record.signature) {
      try {
        await api.wrap.confirm(
          { request_id: record.request_id, signature: record.signature },
          { signal },
        )
        return "confirmed"
      } catch (error) {
        if (!(error instanceof ApiError)) throw error
        if (error.code === "transaction_failed") return "failed"
        // "Not finalized yet", a busy service and a dropped connection pass.
        if (!error.isRetryable) return "unknown"
        if (error.code === "transaction_not_finalized") notOnChain = true
        if (error.retryAfter) pause = Math.max(pause, error.retryAfter * 1_000)
      }
    }
    const left = record.at + EXPIRY_MS - now()
    if (left <= 0) {
      // Past its blockhash a signed transaction can no longer land, so one the
      // service saw missing is gone. One with no signature, or that the service
      // never answered about, may have landed before then.
      return notOnChain ? "failed" : "unknown"
    }
    await sleep(Math.min(pause, left), signal)
  }
}
