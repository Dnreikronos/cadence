import type { Role } from "@/lib/auth/guard"
import { COMPANY_WALLET, ME_WALLET } from "@/lib/api/mocks/db"
import { mockFinality } from "@/lib/api/mocks/chain"
import { mockSigner, mockSubmit } from "@/lib/api/mocks/signer"
import { unavailableWallet, type Wallet } from "./types"

// Imported only through the guarded `import()` in the provider, so none of this
// reaches a real-mode bundle.
const addresses: Partial<Record<Role, string>> = {
  admin: COMPANY_WALLET,
  recipient: ME_WALLET,
}

export function mockWalletFor(role: Role): Wallet {
  const address = addresses[role]
  // Auditors read; they hold no wallet.
  if (!address) return unavailableWallet("auditors do not hold a wallet")
  return {
    status: "ready",
    loading: false,
    address,
    signer: mockSigner(address),
    submit: mockSubmit,
    finality: mockFinality,
  }
}
