import type { ApiClient } from "@/lib/api/client"
import { ApiError, messageFor } from "@/lib/api/errors"
import {
  ConfirmTimeoutError,
  UnexpectedSignerError,
  type SignStep,
} from "@/lib/api/sign"
import type { bindSignAndConfirm } from "@/lib/wallet/sign-and-confirm"
import { WalletUnavailableError, type Wallet } from "@/lib/wallet/types"

export type ApplyPendingDeps = {
  accounts: Pick<ApiClient["accounts"], "applyPending" | "confirmApplyPending">
  wallet: Wallet
  run: ReturnType<typeof bindSignAndConfirm>
}

// Prepare, sign and confirm the transaction that moves pending credits into the
// available balance. Throws what the service or the wallet threw;
// `applyPendingMessage` turns that into copy.
export async function applyPending(
  { accounts, wallet, run }: ApplyPendingDeps,
  onStep?: (step: SignStep) => void,
) {
  if (wallet.status !== "ready") {
    throw new WalletUnavailableError(wallet.reason ?? "no wallet")
  }
  const prepared = await accounts.applyPending(wallet.address)
  return run(
    prepared,
    (signature) =>
      accounts.confirmApplyPending({
        request_id: prepared.request_id,
        signature,
      }),
    onStep,
  )
}

// Never the raw message: errors can carry request details.
export function applyPendingMessage(error: unknown): string {
  if (error instanceof WalletUnavailableError) {
    return "Your wallet can't sign here yet."
  }
  if (error instanceof ConfirmTimeoutError) {
    return "The network hasn't confirmed this yet. Check your balance in a minute before trying again."
  }
  if (error instanceof UnexpectedSignerError) {
    return "That transaction wasn't prepared for your wallet. Try again."
  }
  if (error instanceof ApiError) return messageFor(error)
  return "Couldn't apply your pending balance. Try again."
}
