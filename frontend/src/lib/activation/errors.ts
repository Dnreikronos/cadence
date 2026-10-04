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

// Not something to retry: nothing on this device or account will change by asking again.
export function isWalletUnavailable(error: unknown) {
  return (
    error instanceof WalletCreationUnavailableError ||
    error instanceof WalletUnavailableError
  )
}

// Copy for a failed step. It never reads `error.message`, so nothing a signer or
// the network threw (and certainly no signature) can reach the page.
export function activationMessage(error: unknown): string {
  if (isWalletUnavailable(error)) {
    return "Wallet creation isn't available yet. Nothing changed on your account."
  }
  if (error instanceof ConfirmTimeoutError) {
    return "The network is taking longer than usual to confirm. Try again: setup picks up where it stopped."
  }
  if (error instanceof UnexpectedSignerError) {
    return "The setup asked for a signature from a wallet that isn't yours, so it was refused. Try again."
  }
  if (isApiError(error)) return messageFor(error)
  return "Something went wrong. Try again."
}
