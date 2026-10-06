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
  RunInputUnavailableError,
  SentPaymentError,
  isSignatureRejection,
} from "./errors"

// Copy for the run screens, keyed by the contract's codes. Codes the shared catalog
// does not cover are added here; anything else falls through to `messageFor`. A message
// never carries an amount, an address or a signature.
const overrides: Record<string, string> = {
  run_not_found: "We couldn't find that payroll run.",
  // A recipient account that cannot receive private payments, or a balance that changed.
  invalid_confidential_state:
    "This payment couldn't be prepared: the recipient's account or your balance isn't ready. Retry it.",
  proof_generation_failed: "This payment couldn't be prepared. Retry it.",
  transaction_failed: "The network rejected this payment. You can retry it.",
  invalid_payments:
    "Cadence refused this run: someone is listed twice, or a payment is to your own account.",
  wallet_access_denied: "This wallet can't pay from the company's account.",
  // The service refuses a retry while a payment of the run can still land.
  outstanding_payments:
    "Some payments in this run can still go through. Retry once they have expired, in about a minute.",
  original_signature_required:
    "Some payments in this run can still go through. Retry once they have expired, in about a minute.",
  transaction_not_finalized:
    "Some payments in this run can still go through. Retry once they have expired, in about a minute.",
  payment_attempt_changed:
    "This payment was prepared again since it was signed. Refresh the run.",
  payment_already_resolved:
    "This payment already has a final result. Refresh the run.",
  transaction_history_unavailable:
    "Cadence can't tell whether this payment went through. Check the company payments before paying this person another way.",
  runs_requires_devnet: "Payroll runs only work on devnet for now.",
  run_storage_unavailable:
    "Cadence can't record payroll runs right now. Try again shortly.",
}

export function runMessage(error: unknown) {
  if (isApiError(error) && Object.hasOwn(overrides, error.code)) {
    return overrides[error.code]
  }
  return messageFor(error)
}

// A stable error code from a run's payment, or null.
export function failureCodeMessage(code: string | null) {
  if (!code) return "This payment didn't go through. You can retry it."
  return runMessage(new ApiError(409, code))
}

// The service says it expired without landing: a retry prepares it again.
export const expiredMessage =
  "This payment expired before it went through. You can retry it."

// Prepared and never sent from this browser: its transaction is no longer held here, so
// it cannot land from here. Another browser that signed it would still hold its record.
export const notSentMessage =
  "Not sent: this payment was never signed here, so this person wasn't paid in this run. Check the company payments, then pay them in a new run."

export const sentWithSignatureMessage =
  "This payment was sent but isn't confirmed yet. Check again; don't pay this person another way until it is, or they could be paid twice."

export const sentWithoutSignatureMessage =
  "This payment may have been sent. Check the company payments and balance before doing anything."

// A status the service sent and this app does not know: the payment may be in flight or
// paid, so nothing is offered for it.
export const unrecognizedMessage =
  "Status unknown: check the company payments before doing anything."

// A cancelled signature sent nothing, and stopped the run there.
export const cancelledMessage =
  "You cancelled the signature. Nothing was sent: sign again to continue the run from this payment."

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
  if (error instanceof RunInputUnavailableError) {
    return {
      message: "Payroll runs aren't available in this environment yet.",
      sent: false,
    }
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
    return { message: cancelledMessage, sent: false }
  }
  return { message: runMessage(error), sent: false }
}
