import type { Receipt, RunCreated, RunPaymentPrepared } from "@/lib/api/schemas"
import { ConfirmTimeoutError, type SignStep } from "@/lib/api/sign"
import {
  ResponseMismatchError,
  SentPaymentError,
  rejectedByNetwork,
} from "./errors"

// Signs a run's payments one after another. Kept free of React and of the client so
// the order, the isolation of failures and the retry rules can be tested on their own.
//
// The rule that keeps a person from being paid twice: from the moment signing hands
// over to submitting, the transaction may be on the network. Every failure after that
// point, whatever its cause, is a `SentPaymentError` and is never answered with a new
// transaction. The one exception is the network itself rejecting the transaction
// (`transaction_failed`): it ran and did not land.

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
  // About to hand the signed transaction to the network, before the send itself: from
  // here it may be on the network whatever happens next.
  sending?: (prepared: RunPaymentPrepared) => void
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
  let phase = "signing" as SignStep
  let signature = null as string | null
  events.signing(id)
  try {
    await sign(
      prepared,
      (sig) => api.confirmPayment(runId, id, sig),
      (step) => {
        // The record of the send comes first, and the phase moves on only once it is
        // kept: if keeping it fails (it throws), nothing was sent.
        if (step === "submitting") events.sending?.(prepared)
        phase = step
        events[stepEvent(step)](id)
      },
      {
        signal,
        onSubmitted: (sig) => {
          signature = sig
          events.submitted(id, sig)
        },
      },
    )
    events.confirmed(id)
  } catch (error) {
    // Leaving the page is not a payment failure: the payment stays as it was.
    if (signal?.aborted) return
    const sent =
      (phase === "submitting" || phase === "confirming") &&
      !rejectedByNetwork(error)
    events.failed(
      id,
      sent
        ? new SentPaymentError(
            error,
            signature ??
              (error instanceof ConfirmTimeoutError ? error.signature : null),
          )
        : error,
    )
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

// Only for a payment the service says did not land (failed or expired): it prepares a
// fresh transaction for that payment alone, which is then signed like the first. What
// comes back must be for the payment that was asked about.
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
  if (prepared.payment_id !== paymentId) {
    events.failed(paymentId, new ResponseMismatchError())
    return
  }
  await payOne(context, prepared)
}

// A transaction that was sent but not confirmed may still land, so it is asked about
// again with the signature we kept, never replaced by a new one. Only the network
// rejecting it settles the matter; every other answer leaves it as sent.
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
    if (signal?.aborted) return
    events.failed(
      paymentId,
      rejectedByNetwork(error) ? error : new SentPaymentError(error, signature),
    )
  }
}
