import { isSignatureRejection } from "./errors"
import type { Signable } from "./executor"

// The prepared transactions of a run that are still to be signed, kept in memory for as
// long as the page is open. A signature the person cancels sends nothing and stops the
// run there, so the same transactions can be signed again, from that one on, without
// asking the service to prepare new ones. A reload forgets them, and nothing returns a
// transaction a second time: a payment whose transaction is gone was not paid, and cannot
// be any more.

// A blockhash lives 150 blocks, about 60 s at 400 ms a block, counted from when the
// service read it, which is before the transaction was held here. There is no cheap read
// of the current block height from the browser, so past 60 s of holding it is treated as
// expired: letting go of one that was still live costs nothing, since it was never sent
// and cannot land. Younger than this it may still have expired, and then the network
// refuses it after the submit, which is handled as any failure after a submit: never
// answered with a new transaction.
export const heldMaxAgeMs = 60_000

export type Held = { prepared: Signable; at: number }

// "ready": the transaction to sign again. "stale": its blockhash is past, so it can no
// longer land. "gone": this page does not hold it.
export type HeldLookup =
  | { status: "ready"; prepared: Signable }
  | { status: "stale" }
  | { status: "gone" }

export function lookupHeld(
  held: Held | undefined,
  now: number,
  maxAgeMs = heldMaxAgeMs,
): HeldLookup {
  if (!held) return { status: "gone" }
  return now - held.at >= maxAgeMs
    ? { status: "stale" }
    : { status: "ready", prepared: held.prepared }
}

// Whether a payment's failure leaves its transaction held to sign again: only a refused
// signature does. Anything that came after the submit arrives wrapped in a
// `SentPaymentError`, so it is never a refusal, and the transaction is dropped.
export const keepsHeld = (error: unknown) => isSignatureRejection(error)

export function createHeldStore(now: () => number = Date.now) {
  const held = new Map<string, Held>()
  return {
    // By `paymentKey`.
    hold(key: string, prepared: Signable) {
      held.set(key, { prepared, at: now() })
    },
    has: (key: string) => held.has(key),
    // Looks, and keeps it: a signature cancelled again leaves it held.
    lookup: (key: string) => lookupHeld(held.get(key), now()),
    // Once it was sent, confirmed, or replaced: it must never be signed again.
    drop: (key: string) => void held.delete(key),
    // Everything a run still holds, in position order: what a sequence that stopped
    // would sign next.
    ofRun: (runId: string) =>
      [...held.entries()]
        .filter(([key]) => key.startsWith(`${runId}:`))
        .map(([, entry]) => entry.prepared)
        .sort((a, b) => a.position - b.position),
  }
}

export type HeldStore = ReturnType<typeof createHeldStore>
