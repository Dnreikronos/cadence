import type { RunPaymentPrepared } from "@/lib/api/schemas"
import { EXPIRY_MS } from "@/lib/deposit/reconcile"
import { isSignatureRejection } from "./errors"

// The prepared transactions of a run, kept in memory for as long as the page is open.
// A signature the person cancels sends nothing, so the same transaction can be signed
// again without asking the service to prepare a new one. A reload forgets them, and
// nothing returns a transaction a second time: a payment whose transaction is gone can
// only be paid by a new run.

// A blockhash lives up to about 90 s from the moment it is read, the same clock the
// deposit uses. There is no cheap read of the current block height from the browser, so
// past this age the transaction is treated as expired. Younger than this it may still
// have expired, and then the network refuses it after the submit, which is handled as
// any failure after a submit: never answered with a new transaction.
export const heldMaxAgeMs = EXPIRY_MS

export type Held = { prepared: RunPaymentPrepared; at: number }

// "ready": the transaction to sign again. "stale": its blockhash is past, so a normal
// retry is the way on. "gone": this page does not hold it.
export type HeldLookup =
  | { status: "ready"; prepared: RunPaymentPrepared }
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
    hold(prepared: RunPaymentPrepared) {
      held.set(prepared.payment_id, { prepared, at: now() })
    },
    holdAll(payments: readonly RunPaymentPrepared[]) {
      for (const prepared of payments) this.hold(prepared)
    },
    has: (paymentId: string) => held.has(paymentId),
    // Looks, and keeps it: a signature cancelled again leaves it held.
    lookup: (paymentId: string) => lookupHeld(held.get(paymentId), now()),
    // Once it was sent, confirmed, or replaced: it must never be signed again.
    drop: (paymentId: string) => void held.delete(paymentId),
  }
}

export type HeldStore = ReturnType<typeof createHeldStore>
