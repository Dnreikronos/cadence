import type { Receipt, RunCreated, RunPaymentPrepared } from "@/lib/api/schemas"
import { isApiError } from "@/lib/api/errors"
import { ConfirmTimeoutError, type SignStep } from "@/lib/api/sign"

// Signs a run's payments one after another. Kept free of React and of the client so
// the order, the isolation of failures and the retry rules can be tested on their own.

type SignAndConfirm = (
  prepared: Pick<RunPaymentPrepared, "transaction" | "required_signers">,
  confirm: (signature: string) => Promise<Receipt>,
  onStep?: (step: SignStep) => void,
  extra?: { signal?: AbortSignal; onSubmitted?: (signature: string) => void },
) => Promise<Receipt>

export type RunApi = {
  confirmPayment: (
    runId: string,
    paymentId: string,
    signature: string,
  ) => Promise<Receipt>
  retryPayment: (
    runId: string,
    paymentId: string,
  ) => Promise<RunPaymentPrepared>
}

// What happened to one payment. `failed` carries the raw error: the caller words it.
export type RunEvents = {
  signing: (paymentId: string) => void
  waiting: (paymentId: string) => void
  submitted: (paymentId: string, signature: string) => void
  confirmed: (paymentId: string) => void
  failed: (paymentId: string, error: unknown) => void
}

export type RunContext = {
  runId: string
  sign: SignAndConfirm
  api: RunApi
  events: RunEvents
  // Stops signing, e.g. when the page is left.
  signal?: AbortSignal
}

// Signing and sending count as "signing"; the wait for the network is "waiting".
const stepEvent = (step: SignStep) =>
  step === "confirming" ? "waiting" : "signing"

// Never throws: a failure is reported as an event and the caller moves on.
export async function payOne(
  { runId, sign, api, events, signal }: RunContext,
  prepared: RunPaymentPrepared,
) {
  const id = prepared.payment_id
  events.signing(id)
  try {
    await sign(
      prepared,
      (signature) => api.confirmPayment(runId, id, signature),
      (step) => events[stepEvent(step)](id),
      { signal, onSubmitted: (signature) => events.submitted(id, signature) },
    )
    events.confirmed(id)
  } catch (error) {
    // Leaving the page is not a payment failure: the payment stays as it was.
    if (signal?.aborted) return
    events.failed(id, error)
  }
}

// The payments in the order the service gave them. One failure never blocks the rest.
export async function paySequence(
  context: RunContext,
  payments: RunCreated["payments"],
) {
  for (const prepared of payments) {
    if (context.signal?.aborted) return
    await payOne(context, prepared)
  }
}

// Only for a payment that did not land (failed or expired): the service prepares a
// fresh transaction for that payment alone, which is then signed like the first.
export async function retryOne(context: RunContext, paymentId: string) {
  const { runId, api, events, signal } = context
  events.signing(paymentId)
  let prepared: RunPaymentPrepared
  try {
    prepared = await api.retryPayment(runId, paymentId)
  } catch (error) {
    if (!signal?.aborted) events.failed(paymentId, error)
    return
  }
  await payOne(context, prepared)
}

// A transaction that was sent but not confirmed in time may still land, so it is asked
// about again with the signature we kept, never replaced by a new one.
export async function recheckOne(
  { runId, api, events, signal }: RunContext,
  paymentId: string,
  signature: string,
) {
  events.waiting(paymentId)
  try {
    await api.confirmPayment(runId, paymentId, signature)
    events.confirmed(paymentId)
  } catch (error) {
    if (!signal?.aborted)
      events.failed(paymentId, stillWaiting(error, signature))
  }
}

// "Not finalized yet" and a busy network leave the payment waiting, signature kept.
function stillWaiting(error: unknown, signature: string): unknown {
  return isApiError(error) && error.isRetryable
    ? new ConfirmTimeoutError(signature)
    : error
}
