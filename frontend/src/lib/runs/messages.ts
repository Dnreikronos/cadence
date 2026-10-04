import { ApiError, isApiError, messageFor } from "@/lib/api/errors"
import { ConfirmTimeoutError, UnexpectedSignerError } from "@/lib/api/sign"
import { WalletUnavailableError } from "@/lib/wallet/types"

// Copy for the run screens, keyed by the contract's codes. Codes the shared catalog
// does not cover are added here; anything else falls through to `messageFor`. A message
// never carries an amount, an address or a signature.
const overrides: Record<string, string> = {
  person_not_found: "That person is no longer on your list.",
  run_not_found: "We couldn't find that payroll run.",
  payment_not_found: "That payment is no longer part of this run.",
  payment_not_retryable:
    "That payment can't be retried right now. Check its status first.",
  person_already_active: "That person already has an account.",
  person_removed: "That person was removed, so they can't be invited.",
  recipient_not_activated:
    "Someone on this run hasn't set up their account yet. Refresh the list and try again.",
  invalid_confidential_state:
    "Your private balance is lower than this run needs. Deposit more and try again.",
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

export const expiredMessage =
  "This payment expired before the network confirmed it. Retry to prepare a new one."

export type Failure = {
  message: string
  // The transaction reached the network but was not confirmed in time, so a new one
  // could pay twice. It can only be checked again.
  stalled: boolean
  signature?: string
}

export function describeFailure(error: unknown): Failure {
  if (error instanceof ConfirmTimeoutError) {
    return {
      message:
        "The network is taking longer than usual to confirm this payment. Check again in a moment before retrying.",
      stalled: true,
      signature: error.signature,
    }
  }
  if (error instanceof WalletUnavailableError) {
    return {
      message: "Signing isn't available in this environment yet.",
      stalled: false,
    }
  }
  if (error instanceof UnexpectedSignerError) {
    return {
      message:
        "This payment needs a different wallet than the one you're signed in with.",
      stalled: false,
    }
  }
  return { message: runMessage(error), stalled: false }
}

export function inviteMessage(error: unknown) {
  return runMessage(error)
}
