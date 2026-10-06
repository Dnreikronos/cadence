import { ApiError } from "@/lib/api/errors"
import type {
  Receipt,
  Run,
  RunPaymentPrepared,
  RunRetryRequest,
} from "@/lib/api/schemas"
import { isSignable } from "@/lib/api/schemas"
import { ConfirmTimeoutError, type SignStep } from "@/lib/api/sign"
import {
  ResponseMismatchError,
  SentPaymentError,
  rejectedByNetwork,
} from "./errors"

// Signs a run's payments one after another, in ascending position (docs/dev/RUNS_API.md).
// Kept free of React and of the client so the order, the stop and the retry rules can be
// tested on their own.
//
// Each payment's proof assumes the ones before it landed, so the sequence stops at the
// first payment that does not finalize: the later transactions were built for a balance
// that no longer exists. They were never signed, never left this page, and cannot land.
//
// The rule that keeps a person from being paid twice: from the moment signing hands over
// to submitting, the transaction may be on the network. Every failure after that point,
// whatever its cause, is a `SentPaymentError` and is never answered with a new
// transaction. The one exception is the network itself rejecting the transaction
// (`transaction_failed`): it ran and did not land.

type SignAndConfirm = (
  prepared: Pick<Signable, "transaction" | "required_signers">,
  confirm: (signature: string) => Promise<Receipt>,
  onStep?: (step: SignStep) => void,
  extra?: { signal?: AbortSignal; onSubmitted?: (signature: string) => void },
) => Promise<Receipt>

export type RunApi = {
  confirm: (
    runId: string,
    item: { position: number; request_id: string; signature: string },
  ) => Promise<Run>
  retry: (runId: string, request: RunRetryRequest) => Promise<Run>
}

// A prepared payment with the run's signers, which is what signing checks.
export type Signable = RunPaymentPrepared & { required_signers: string[] }

export const signablesOf = (run: Pick<Run, "payments" | "required_signers">) =>
  run.payments
    .filter(isSignable)
    .map((payment) => ({ ...payment, required_signers: run.required_signers }))
    .sort((a, b) => a.position - b.position)

// One payment of one run: its row on screen and its saved record go by this.
export const paymentKey = (runId: string, position: number) =>
  `${runId}:${position}`

// What happened to one payment, by `paymentKey`. `failed` carries the raw error: the
// caller words it.
export type RunEvents = {
  signing: (id: string) => void
  // About to hand the signed transaction to the network, before the send itself: from
  // here it may be on the network whatever happens next.
  sending?: (prepared: RunPaymentPrepared) => void
  waiting: (id: string) => void
  submitted: (id: string, signature: string) => void
  confirmed: (id: string) => void
  failed: (id: string, error: unknown) => void
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

// Item errors that pass with time, like their HTTP twins (`ApiError.isRetryable`).
const busyItemErrors = new Set(["rpc_unavailable", "run_storage_unavailable"])

// One position's confirm, in the shape `signAndConfirm` asks about: a receipt once the
// service recorded it finalized, an `ApiError` otherwise (`transaction_not_finalized`
// keeps it asking; `transaction_failed` is the network's refusal).
export async function confirmPosition(
  api: RunApi,
  runId: string,
  prepared: Pick<RunPaymentPrepared, "position" | "request_id">,
  signature: string,
): Promise<Receipt> {
  const { position, request_id } = prepared
  const run = await api.confirm(runId, { position, request_id, signature })
  const problem = run.errors?.find((error) => error.position === position)
  if (problem) {
    throw new ApiError(
      busyItemErrors.has(problem.error) ? 503 : 409,
      problem.error,
    )
  }
  const payment = run.payments.find((p) => p.position === position)
  if (!payment || payment.request_id !== request_id) {
    throw new ResponseMismatchError()
  }
  if (payment.status === "finalized") {
    return {
      request_id,
      signature: payment.signature ?? signature,
      slot: payment.slot ?? 0,
      status: "finalized",
    }
  }
  if (payment.status === "failed") {
    throw new ApiError(409, payment.error ?? "transaction_failed")
  }
  throw new ApiError(409, "transaction_not_finalized")
}

// Signs, sends and confirms one payment. Never throws: a failure is reported as an
// event. Returns whether it finalized, so the sequence knows whether to go on.
export async function payOne(
  { runId, sign, api, events, signal }: RunContext,
  prepared: Signable,
): Promise<boolean> {
  const id = paymentKey(runId, prepared.position)
  let phase = "signing" as SignStep
  let signature = null as string | null
  events.signing(id)
  try {
    await sign(
      prepared,
      (sig) => confirmPosition(api, runId, prepared, sig),
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
    return true
  } catch (error) {
    // Leaving the page is not a payment failure: the payment stays as it was.
    if (signal?.aborted) return false
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
    return false
  }
}

// The payments in ascending position, each finalized before the next is signed. The
// first one that does not finalize (refused, cancelled, or sent and not confirmed) stops
// the sequence, and its position is returned; null when every one finalized.
export async function paySequence(
  context: RunContext,
  payments: readonly Signable[],
): Promise<number | null> {
  const ordered = [...payments].sort((a, b) => a.position - b.position)
  for (const prepared of ordered) {
    if (context.signal?.aborted) return prepared.position
    if (!(await payOne(context, prepared))) return prepared.position
  }
  return null
}

// Positions a retry prepares again: the ones the network refused and the ones the
// service could not prepare. A finalized one is never sent again, and a prepared one
// may still land, so neither is ever in a retry.
export const retryablePositions = (run: Pick<Run, "payments">) =>
  run.payments
    .filter((p) =>
      ["failed", "expired", "preparation_failed"].includes(p.status),
    )
    .map((p) => p.position)

// The run's failed positions prepared again under the original approval, with the
// amounts given. Returns what came back to sign, in order, or null when the retry was
// refused (each position asked about is then reported failed with the reason). Live
// prepared positions are not sent: the service refuses the retry while any can still
// land (`outstanding_payments`), and the caller says to wait for them to expire.
export async function retryRun(
  context: RunContext,
  run: Pick<Run, "payments">,
  request: RunRetryRequest,
): Promise<Signable[] | null> {
  const { runId, api, events, signal } = context
  const asked = request.payments.map((p) => p.position)
  const fail = (position: number, error: unknown) =>
    events.failed(paymentKey(runId, position), error)
  // Nothing is shown as signing before the answer: a rebuilt position the sequence then
  // never reaches (it stopped earlier) would be left looking like it was in flight.
  let after: Run
  try {
    after = await api.retry(runId, request)
  } catch (error) {
    if (!signal?.aborted) for (const position of asked) fail(position, error)
    return null
  }
  // Every position must come back for the same account, and only positions asked about
  // may come back with a transaction to sign.
  const before = new Map(run.payments.map((p) => [p.position, p.destination]))
  const rebuilt = signablesOf(after)
  if (
    after.payments.length !== run.payments.length ||
    after.payments.some((p) => before.get(p.position) !== p.destination) ||
    rebuilt.some((p) => !asked.includes(p.position))
  ) {
    for (const position of asked) fail(position, new ResponseMismatchError())
    return null
  }
  // A position asked about that did not come back prepared keeps the service's word:
  // landed (it skips a finalized one), or why not.
  for (const position of asked) {
    if (rebuilt.some((p) => p.position === position)) continue
    const payment = after.payments.find((p) => p.position === position)
    if (payment?.status === "finalized") {
      events.confirmed(paymentKey(runId, position))
      continue
    }
    fail(position, new ApiError(409, payment?.error ?? "invalid_payment"))
  }
  return rebuilt
}

// A transaction that was sent but not confirmed may still land, so it is asked about
// again with the signature we kept, never replaced by a new one. Only the network
// rejecting it settles the matter; every other answer leaves it as sent.
export async function recheckOne(
  { runId, api, events, signal }: RunContext,
  prepared: Pick<RunPaymentPrepared, "position" | "request_id">,
  signature: string,
) {
  const id = paymentKey(runId, prepared.position)
  events.waiting(id)
  try {
    await confirmPosition(api, runId, prepared, signature)
    events.confirmed(id)
  } catch (error) {
    if (signal?.aborted) return
    events.failed(
      id,
      rejectedByNetwork(error) ? error : new SentPaymentError(error, signature),
    )
  }
}
