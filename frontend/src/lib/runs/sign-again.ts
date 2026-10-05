import {
  payOne,
  type RunApi,
  type RunContext,
  type RunEvents,
} from "./executor"
import { keepsHeld, type HeldStore } from "./held"
import { cancelledStaleMessage, describeFailure } from "./messages"
import type { LocalAction } from "./progress"

// The wiring between a run's events, the local rows and the held transactions, kept free
// of React so that the hook and its tests run the same code. What it decides: a
// transaction stays held only while nothing was handed to the network.

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

// A transaction prepared by a retry is held like the first ones.
export function holdingRetries(api: RunApi, held: HeldStore): RunApi {
  return {
    ...api,
    retryPayment: async (runId, paymentId) => {
      const prepared = await api.retryPayment(runId, paymentId)
      if (prepared.payment_id === paymentId) held.hold(prepared)
      return prepared
    },
  }
}

// Signs the held transaction of a cancelled payment again, without preparing a new one.
// Past its blockhash it is dropped and the payment is shown as failed, so the normal
// retry applies; one this page does not hold is left as it is.
export async function signAgain(
  context: RunContext,
  held: HeldStore,
  dispatch: (action: LocalAction) => void,
  paymentId: string,
) {
  const found = held.lookup(paymentId)
  if (found.status === "ready") return payOne(context, found.prepared)
  if (found.status === "stale") {
    held.drop(paymentId)
    dispatch({
      type: "failed",
      id: paymentId,
      message: cancelledStaleMessage,
      sent: false,
    })
  }
}
