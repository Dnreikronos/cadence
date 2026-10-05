import { ApiError, isApiError, messageFor } from "@/lib/api/errors"
import { ConfirmTimeoutError, UnexpectedSignerError } from "@/lib/api/sign"
import {
  StorageUnavailableError,
  storageBlockedMessage,
} from "@/lib/storage-guard"
import { WalletUnavailableError } from "@/lib/wallet/types"
import {
  PaymentNotOnChainError,
  ResponseMismatchError,
  SentPaymentError,
  isSignatureRejection,
} from "./errors"

// Copy for the run screens, keyed by the contract's codes. Codes the shared catalog
// does not cover are added here; anything else falls through to `messageFor`. A message
// never carries an amount, an address or a signature.
const overrides: Record<string, string> = {
  person_not_found: "That person is no longer on your list.",
  run_not_found: "We couldn't find that payroll run.",
  payment_not_found: "That payment is no longer part of this run.",
  payment_not_retryable:
    "That payment can't be retried right now. Check its status first.",
  recipient_not_activated:
    "Someone on this run hasn't set up their account yet. Refresh the list and try again.",
  // Each payment's proof is built before the one ahead of it lands, so later payments
  // can find the balance changed. A retry builds a fresh one.
  invalid_confidential_state:
    "The balance changed while signing. Retry this payment.",
  transaction_failed: "The network rejected this payment. You can retry it.",
}

export function runMessage(error: unknown) {
  if (isApiError(error) && Object.hasOwn(overrides, error.code)) {
    return overrides[error.code]
  }
  return messageFor(error)
}

// A stable failure code from `GET /runs/:id`, or null.
export function failureCodeMessage(code: string | null) {
  if (!code) return "This payment didn't go through. You can retry it."
  return runMessage(new ApiError(409, code))
}

// `expired` is not defined by the draft contract: it is shown, but a retry is only
// allowed once the service has confirmed that the payment did not land.
export const expiredMessage =
  "This payment expired before it was confirmed. You can retry it only if the service confirms it didn't land; if it won't, check your payments and balance first."

export const sentWithSignatureMessage =
  "This payment was sent but isn't confirmed yet. Check again; don't pay this person another way until it is, or they could be paid twice."

export const sentWithoutSignatureMessage =
  "This payment may have been sent. Check the company payments and balance before doing anything."

// A status the service sent and this app does not know: the payment may be in flight or
// paid, so nothing is offered for it.
export const unrecognizedMessage =
  "Status unknown: check the company payments before doing anything."

// A cancelled signature sent nothing. These say what to do next without ever suggesting
// the person was paid.
export const cancelledGoneMessage =
  "You cancelled the signature, and this page no longer holds this payment, so this person was not paid. Start a new run for them only. The recently-paid check won't skip them, because nothing was confirmed."

export const cancelledStaleMessage =
  "Too much time has passed to sign this payment again, and nothing was sent, so this person was not paid. Retry it to prepare a new one; if that isn't allowed, start a new run for them only."

export type Failure = {
  message: string
  // The transaction may have reached the network: never prepare another for it.
  sent: boolean
  // Known once the network took it, so it can be asked about again.
  signature?: string
}

export function describeFailure(error: unknown): Failure {
  if (
    error instanceof SentPaymentError ||
    error instanceof ConfirmTimeoutError
  ) {
    const signature =
      error instanceof SentPaymentError
        ? (error.signature ??
          (error.original instanceof ConfirmTimeoutError
            ? error.original.signature
            : null))
        : error.signature
    return signature
      ? { message: sentWithSignatureMessage, sent: true, signature }
      : { message: sentWithoutSignatureMessage, sent: true }
  }
  if (error instanceof WalletUnavailableError) {
    return {
      message: "Signing isn't available in this environment yet.",
      sent: false,
    }
  }
  if (error instanceof UnexpectedSignerError) {
    return {
      message:
        "This payment needs a different wallet than the one you're signed in with.",
      sent: false,
    }
  }
  if (error instanceof StorageUnavailableError) {
    return { message: storageBlockedMessage, sent: false }
  }
  if (error instanceof PaymentNotOnChainError) {
    return { message: failureCodeMessage(null), sent: false }
  }
  if (error instanceof ResponseMismatchError) {
    return {
      message:
        "Cadence answered for a different payment than this one, so nothing was signed.",
      sent: false,
    }
  }
  if (isSignatureRejection(error)) {
    return {
      message: "You cancelled the signature. Nothing was sent.",
      sent: false,
    }
  }
  return { message: runMessage(error), sent: false }
}
