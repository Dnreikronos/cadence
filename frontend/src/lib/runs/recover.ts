import type { Receipt } from "@/lib/api/schemas"
import { reconcileWrap, type Reconciled } from "@/lib/deposit/reconcile"
import { PaymentNotOnChainError, SentPaymentError } from "./errors"
import type { SentPayment } from "./evidence"
import { confirmPosition, paymentKey, type RunContext } from "./executor"
import { sentWithoutSignatureMessage } from "./messages"
import type { LocalRows } from "./progress"

// Picking a run back up after a reload. The payments that reached the submit step were
// kept (`evidence.ts`); each is confirmed again with its saved signature, which the
// service answers idempotently, and nothing is prepared or signed. A payment that never
// reached the submit step has no record, and its transaction was only ever in the page
// that created the run, so it cannot be signed any more and cannot land: it is not paid.

// What the screen shows for each saved payment before it has been asked about: one with
// a signature is being checked (waiting, not yet stalled, so no "Check again"), one
// without may have been sent and cannot be asked about.
export function hydrateLocal(payments: readonly SentPayment[]): LocalRows {
  const rows: LocalRows = {}
  for (const payment of payments) {
    rows[paymentKey(payment.run_id, payment.position)] = payment.signature
      ? { status: "waiting", signature: payment.signature }
      : { status: "unknown", message: sentWithoutSignatureMessage }
  }
  return rows
}

type ReconcileOptions = Pick<
  Parameters<typeof reconcileWrap>[0],
  "blockHeight" | "sleep" | "pollMs"
>

// Asks about one saved payment until the answer is final: confirmed, failed (the
// network refused it, or it was seen missing once its last valid block height had
// passed) or unknown (no signature, a service that could not be reached or that no
// longer has it). Only leaving the screen throws.
export async function reconcilePayment(
  record: SentPayment,
  confirm: (signature: string) => Promise<Receipt>,
  signal?: AbortSignal,
  options: ReconcileOptions = {},
): Promise<Reconciled> {
  if (!record.signature) return "unknown"
  try {
    return await reconcileWrap({
      record: {
        request_id: record.request_id,
        signature: record.signature,
        last_valid_block_height: record.last_valid_block_height,
      },
      api: { wrap: { confirm: (request) => confirm(request.signature) } },
      signal,
      ...options,
    })
  } catch {
    // Not being able to ask says nothing about the payment.
    signal?.throwIfAborted()
    return "unknown"
  }
}

// Looks up one saved payment and reports what it found through the run's events: the
// row shows as waiting meanwhile, then confirmed, failed, or sent and unconfirmed with
// "Check again". One with no signature is reported as sent without one.
export async function recoverOne(
  { api, events, signal }: RunContext,
  record: SentPayment,
  options: ReconcileOptions = {},
) {
  const id = paymentKey(record.run_id, record.position)
  if (!record.signature) {
    events.failed(id, new SentPaymentError(null, null))
    return
  }
  events.waiting(id)
  let outcome: Reconciled
  try {
    outcome = await reconcilePayment(
      record,
      (signature) => confirmPosition(api, record.run_id, record, signature),
      signal,
      options,
    )
  } catch {
    // Left the screen: the payment stays as it was.
    return
  }
  if (outcome === "confirmed") events.confirmed(id)
  else if (outcome === "failed") events.failed(id, new PaymentNotOnChainError())
  else events.failed(id, new SentPaymentError(null, record.signature))
}
