import type { Signer } from "@/lib/api/sign"

// What a screen gets from `useWallet()`. `unavailable` means nothing can sign here
// (an auditor holds no wallet, and real mode waits for the embedded wallet); the
// signer and `submit` then throw, so a missed check fails loudly, not silently.
export type Wallet = {
  status: "ready" | "unavailable"
  // True while the mock wallet is still loading, so a screen can wait rather
  // than flash "unavailable". Always false in real mode.
  loading: boolean
  // Why nothing can sign, when it cannot.
  reason?: string
  address: string
  signer: Signer
  // Sends signed bytes to Solana and returns the transaction signature.
  submit: (signed: Uint8Array) => Promise<string>
}

export class WalletUnavailableError extends Error {
  constructor(reason: string) {
    super(`Wallet unavailable: ${reason}`)
    this.name = "WalletUnavailableError"
  }
}

export const realModeReason =
  "the embedded wallet is not integrated yet (#78 login and wallet route, #80 signing)"

export function unavailableWallet(reason: string, loading = false): Wallet {
  const fail = (): never => {
    throw new WalletUnavailableError(reason)
  }
  return {
    status: "unavailable",
    loading,
    reason,
    address: "",
    signer: {
      address: "",
      signTransaction: async () => fail(),
      signMessage: async () => fail(),
    },
    submit: async () => fail(),
  }
}
