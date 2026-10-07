import type { ApiClient } from "@/lib/api/client"
import { ApiError } from "@/lib/api/errors"
import {
  pastBlockhash,
  readBlockHeight,
  type ReadBlockHeight,
} from "@/lib/solana/block-height"
import type { Submission } from "@/lib/submissions"

// What became of a wrap that was sent and not seen through.
// - confirmed: it landed. The wrapped amount is pending until it is applied.
// - failed: the network dropped it, or its blockhash ran out with no way to
//   land. Nothing was taken, so depositing again is safe.
// - unknown: it may or may not have landed and cannot be told from here (no
//   signature came back, the service no longer has the record, or the chain's height
//   could not be read for long enough that the screen should offer to check again).
export type Reconciled = "confirmed" | "failed" | "unknown"

type Input = {
  // What the check reads of a record: withdrawals and payroll payments keep their own
  // shapes and pass just these three.
  record: Pick<
    Submission,
    "request_id" | "signature" | "last_valid_block_height"
  >
  // Only the confirm call is used, so another transaction's confirm can stand in.
  api: { wrap: Pick<ApiClient["wrap"], "confirm"> }
  signal?: AbortSignal
  // The finalized block height (lib/solana/block-height.ts): the chain in real mode,
  // the mock chain in mock mode.
  blockHeight?: ReadBlockHeight
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
  pollMs?: number
  // Whether a "not there" given once the height was seen past rules it failed. True for a
  // wrap, an apply and a withdrawal, whose service checks the chain itself. A payroll
  // payment passes false: a "not there" proves nothing about it (gotchas.md), so it
  // stays unknown.
  missingPastIsFailed?: boolean
  // How many height reads in a row may fail before it gives up as unknown.
  unreadableHeights?: number
}

// About two minutes of asking at the default pace, longer than a blockhash lives.
export const maxUnreadableHeights = 40

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
//
// The transaction can no longer land once the finalized block height is past its
// `last_valid_block_height`. The height is read before each ask, so only a "not there"
// given after the height was seen past makes it failed: one that landed in time is
// finalized by then, and the service says so. While the height cannot be read nothing is
// ruled failed, and after `unreadableHeights` failed reads in a row it is unknown rather
// than asked about forever.
export async function reconcileWrap({
  record,
  api,
  signal,
  blockHeight = readBlockHeight,
  sleep = wait,
  pollMs = 3_000,
  missingPastIsFailed = true,
  unreadableHeights = maxUnreadableHeights,
}: Input): Promise<Reconciled> {
  let unread = 0
  // A height that cannot be read says nothing: the blockhash may still be live.
  const pastNow = async () => {
    try {
      const height = await blockHeight(signal)
      unread = 0
      return pastBlockhash(record.last_valid_block_height, height)
    } catch {
      signal?.throwIfAborted()
      unread += 1
      return false
    }
  }
  for (;;) {
    signal?.throwIfAborted()
    const past = await pastNow()
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
        // Past its blockhash a signed transaction can no longer land, so one the
        // service sees missing is gone, where its "not there" is evidence.
        if (
          error.code === "transaction_not_finalized" &&
          past &&
          missingPastIsFailed
        ) {
          return "failed"
        }
        if (error.retryAfter) pause = Math.max(pause, error.retryAfter * 1_000)
      }
    }
    // One with no signature, or that the service did not answer about, may have
    // landed in time.
    if (past || unread >= unreadableHeights) return "unknown"
    await sleep(pause, signal)
  }
}
