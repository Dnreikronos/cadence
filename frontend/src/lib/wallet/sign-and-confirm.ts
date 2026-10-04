import { signAndConfirm, type SignStep } from "@/lib/api/sign"
import type { Receipt } from "@/lib/api/schemas"
import { WalletUnavailableError, type Wallet } from "./types"

type Prepared = Parameters<typeof signAndConfirm>[0]
type Extra = Omit<
  Parameters<typeof signAndConfirm>[1],
  "signer" | "submit" | "confirm" | "onStep"
>

// `signAndConfirm` bound to a wallet, so a screen passes only what it prepared and
// how to confirm it. An unavailable wallet fails before anything is asked of the service.
export function bindSignAndConfirm(wallet: Wallet) {
  return async (
    prepared: Prepared,
    confirm: (signature: string) => Promise<Receipt>,
    onStep?: (step: SignStep) => void,
    extra: Extra = {},
  ): Promise<Receipt> => {
    if (wallet.status !== "ready") {
      throw new WalletUnavailableError(wallet.reason ?? "no wallet")
    }
    return signAndConfirm(prepared, {
      ...extra,
      signer: wallet.signer,
      submit: wallet.submit,
      confirm,
      onStep,
    })
  }
}
