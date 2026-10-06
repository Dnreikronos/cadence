import { base58FromBytes } from "@/lib/api/base58"
import { base64FromBytes } from "@/lib/api/base64"
import { apiConfig } from "@/lib/api/mode"
import type { Signer } from "@/lib/api/sign"

// What `POST /runs` needs besides the people and their amounts, each from one place
// (docs/dev/RUNS_API.md). Real mode refuses each of them until the service says where
// it comes from (the questions on #63), rather than send something it would not accept.

export class RunInputUnavailableError extends Error {
  constructor(readonly input: "sender" | "balance key" | "user") {
    super(`The ${input} for a payroll run is not available yet`)
    this.name = "RunInputUnavailableError"
  }
}

const isMock = () =>
  process.env.NEXT_PUBLIC_API_MODE !== "real" && apiConfig.mode === "mock"

// The company's token account that pays the run: the wallet's Token-2022 account for
// the wrapped mint.
export async function senderAccountFor(wallet: string): Promise<string> {
  if (isMock()) {
    return (await import("@/lib/api/mocks/chain")).mockTokenAccount(wallet)
  }
  throw new RunInputUnavailableError("sender")
}

// The text the wallet signs once to link itself to the signed-in user, as the service
// checks it (`transfer_store.rs`).
export const walletLinkMessage = (userId: string, wallet: string) =>
  new TextEncoder().encode(
    `Cadence wallet association\nuser:${userId}\nwallet:${wallet}`,
  )

export async function walletLinkSignature(signer: Signer, userId: string) {
  if (!signer.signMessage) throw new RunInputUnavailableError("user")
  const signature = await signer.signMessage(
    walletLinkMessage(userId, signer.address),
  )
  return base58FromBytes(signature)
}

// PLACEHOLDER, like activation's key message: the balance key comes from a signature
// over the SDK's derivation message for the sender token account, which the web app
// cannot build yet. Real mode refuses.
export function balanceKeyMessage(tokenAccount: string): Uint8Array {
  if (!isMock()) throw new RunInputUnavailableError("balance key")
  return new TextEncoder().encode(
    `Cadence confidential balance key v1\naccount: ${tokenAccount}`,
  )
}

// The 16-byte AES key of the sender's balance, as base64. It is as secret as a key:
// kept in memory only, never stored, never logged.
export async function deriveBalanceKey(signer: Signer, tokenAccount: string) {
  if (!signer.signMessage) throw new RunInputUnavailableError("balance key")
  const signature = await signer.signMessage(balanceKeyMessage(tokenAccount))
  const digest = await crypto.subtle.digest(
    "SHA-256",
    Uint8Array.from(signature),
  )
  return base64FromBytes(new Uint8Array(digest).slice(0, 16))
}
