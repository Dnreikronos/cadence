import { isApiError, messageFor } from "@/lib/api/errors"
import { ConfirmTimeoutError, UnexpectedSignerError } from "@/lib/api/sign"
import { WalletUnavailableError } from "@/lib/wallet/types"

// Step 1 in real mode: the embedded wallet route and Turnkey login are #78, which
// has not landed. Named here so the next person finds where to plug it in.
export class WalletCreationUnavailableError extends Error {
  constructor() {
    super("Wallet creation is not available yet: it waits for #78")
    this.name = "WalletCreationUnavailableError"
  }
}

// The service refused the enrollment as already done, but does not report this
// wallet's key as enrolled: someone enrolled the token account first (API_CONTRACT,
// design finding 3). Retrying cannot fix it, and calling it done would be false.
export class KeyEnrolledElsewhereError extends Error {
  constructor() {
    super("The key for this wallet was enrolled by someone else")
    this.name = "KeyEnrolledElsewhereError"
  }
}

// A step finished, but the service does not report it as done.
export class StepNotConfirmedError extends Error {
  constructor() {
    super("The service does not report this step as done")
    this.name = "StepNotConfirmedError"
  }
}

// Not something to retry: nothing on this device or account will change by asking again.
export function isWalletUnavailable(error: unknown) {
  return (
    error instanceof WalletCreationUnavailableError ||
    error instanceof WalletUnavailableError
  )
}

export const isTerminal = (error: unknown) =>
  error instanceof KeyEnrolledElsewhereError

// Copy for a failed step. It never reads `error.message`, so nothing a signer or
// the network threw (and certainly no signature) can reach the page.
export function activationMessage(error: unknown): string {
  if (isWalletUnavailable(error)) {
    return "Wallet creation isn't available yet. Nothing changed on your account."
  }
  if (error instanceof KeyEnrolledElsewhereError) {
    return "This wallet was set up elsewhere. Contact support."
  }
  if (error instanceof ConfirmTimeoutError) {
    return "Your setup may already have gone through. Check back shortly; we won't start it again."
  }
  if (error instanceof StepNotConfirmedError) {
    return "We couldn't confirm that step yet. Try again in a moment."
  }
  if (error instanceof UnexpectedSignerError) {
    return "The setup asked for a signature from a wallet that isn't yours, so it was refused. Try again."
  }
  if (isApiError(error)) return messageFor(error)
  return "Something went wrong. Try again."
}

// When the status itself cannot be read. A 401 is a sign-in problem and a 404 means
// the route is not there: asking again fixes neither, so they say so.
export function statusMessage(error: unknown): string {
  if (isApiError(error) && error.status === 404) {
    return "Account setup isn't available right now."
  }
  return messageFor(error)
}

export const canRetryStatus = (error: unknown) =>
  !(isApiError(error) && (error.status === 401 || error.status === 404))
