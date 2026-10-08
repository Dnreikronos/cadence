import {
  readBlockHeight,
  type ReadBlockHeight,
} from "@/lib/solana/block-height"
import {
  payOne,
  paymentKey,
  type RunApi,
  type RunContext,
  type RunEvents,
} from "./executor"
import { keepsHeld, type HeldStore } from "./held"
import { describeFailure } from "./messages"
import type { LocalAction } from "./progress"

// The wiring between a run's events, the local rows and the held transactions, kept free
// of React so that the hook and its tests run the same code. What it decides: a
// transaction stays held only while nothing was handed to the network, and a run that
// stopped for any reason but a cancelled signature lets go of everything after the stop.

// Every event goes to the reducer; `submitted` and `confirmed` also drop the held
// transaction, and so does any failure that is not a refused signature (one that came
// once the transaction was submitted arrives wrapped in a `SentPaymentError`, so it is
// never taken for a refusal). `after` is for what the hook adds: refreshing queries.
export function runEvents(
  held: HeldStore,
  dispatch: (action: LocalAction) => void,
  after: { confirmed?: () => void; failed?: () => void } = {},
): RunEvents {
  return {
    signing: (id) => dispatch({ type: "signing", id }),
    waiting: (id) => dispatch({ type: "waiting", id }),
    submitted: (id, signature) => {
      // Handed to the network: this transaction is never signed again.
      held.drop(id)
      dispatch({ type: "submitted", id, signature })
    },
    confirmed: (id) => {
      held.drop(id)
      dispatch({ type: "confirmed", id })
      after.confirmed?.()
    },
    failed: (id, error) => {
      // Cancelled before anything was sent: it stays held, to sign again.
      const cancelled = keepsHeld(error)
      if (!cancelled) held.drop(id)
      dispatch({ type: "failed", id, cancelled, ...describeFailure(error) })
      after.failed?.()
    },
  }
}

export type { RunApi }

// Signs what this page holds for the run, in order, from the first one. A cancelled
// signature keeps it and the ones after it held, to sign again. Any other stop lets go of
// the ones after it: their proofs assumed the stopped payment landed, so they must never
// be sent, and nothing was. A held transaction past its blockhash is let go of too, with
// every one after it. The chain's height is read again before each one is offered: the
// signatures before it may have taken long enough for it to go stale.
export async function continueRun(
  context: RunContext,
  held: HeldStore,
  blockHeight: ReadBlockHeight = readBlockHeight,
) {
  const { runId, signal } = context
  const pending = held.ofRun(runId)
  let stoppedAt: number | null = null
  for (const prepared of pending) {
    if (signal?.aborted) return
    // A height that cannot be read says nothing about the blockhash, and the transaction
    // is let go of. Leaving the page is not that: everything stays as it was.
    let height: number | null
    try {
      height = await blockHeight(signal)
    } catch {
      if (signal?.aborted) return
      height = null
    }
    const key = paymentKey(runId, prepared.position)
    if (held.lookup(key, height).status !== "ready") break
    if (!(await payOne(context, prepared))) {
      stoppedAt = prepared.position
      break
    }
  }
  if (signal?.aborted) return
  const cancelled = stoppedAt !== null && held.has(paymentKey(runId, stoppedAt))
  if (cancelled) return
  for (const prepared of pending) {
    if (stoppedAt === null || prepared.position > stoppedAt) {
      held.drop(paymentKey(runId, prepared.position))
    }
  }
}
