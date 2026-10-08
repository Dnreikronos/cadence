import { base58FromBytes } from "@/lib/api/base58"
import { base64FromBytes } from "@/lib/api/base64"
import { isApiError } from "@/lib/api/errors"
import { apiConfig } from "@/lib/api/mode"
import type { Signer } from "@/lib/api/sign"
import { KeyInputUnavailableError } from "./errors"

// What `POST /runs` needs besides the people and their amounts, each from one place
// (docs/dev/RUNS_API.md). Real mode refuses each of them until the service says where
// it comes from (the questions on #63), rather than send something it would not accept.

const isMock = () =>
  process.env.NEXT_PUBLIC_API_MODE !== "real" && apiConfig.mode === "mock"

// The company's token account that pays the run: the wallet's Token-2022 account for
// the wrapped mint.
export async function senderAccountFor(wallet: string): Promise<string> {
  if (isMock()) {
    return (await import("@/lib/api/mocks/chain")).mockTokenAccount(wallet)
  }
  throw new KeyInputUnavailableError("sender")
}

// The text the wallet signs once to link itself to the signed-in user, as the service
// checks it (`transfer_store.rs`).
export const walletLinkMessage = (userId: string, wallet: string) =>
  new TextEncoder().encode(
    `Cadence wallet association\nuser:${userId}\nwallet:${wallet}`,
  )

export async function walletLinkSignature(signer: Signer, userId: string) {
  if (!signer.signMessage) throw new KeyInputUnavailableError("user")
  const signature = await signer.signMessage(
    walletLinkMessage(userId, signer.address),
  )
  return base58FromBytes(signature)
}

// Sends a request that may be a wallet's first (a run, an unwrap). The service refuses
// a wallet that is not linked yet with `wallet_link_required`: the wallet then signs
// the link text and the same request is sent once more with it. Gives back the request
// that was answered, with the link if one was needed.
export async function sendLinkingWallet<R extends object, T>(
  signer: Signer,
  request: R,
  send: (request: R & { wallet_signature?: string }) => Promise<T>,
  userId: () => Promise<string | null>,
): Promise<{ request: R & { wallet_signature?: string }; answer: T }> {
  try {
    return { request, answer: await send(request) }
  } catch (error) {
    if (!(isApiError(error) && error.code === "wallet_link_required")) {
      throw error
    }
  }
  const user = await userId()
  if (!user) throw new KeyInputUnavailableError("user")
  const linked = {
    ...request,
    wallet_signature: await walletLinkSignature(signer, user),
  }
  return { request: linked, answer: await send(linked) }
}

// PLACEHOLDER, like activation's key message: the balance key comes from a signature
// over the SDK's derivation message for the sender token account, which the web app
// cannot build yet. Real mode refuses.
export function balanceKeyMessage(tokenAccount: string): Uint8Array {
  if (!isMock()) throw new KeyInputUnavailableError("balance key")
  return new TextEncoder().encode(
    `Cadence confidential balance key v1\naccount: ${tokenAccount}`,
  )
}

// The 16-byte AES key of the sender's balance, as base64. It is as secret as a key:
// kept in memory only, never stored, never logged.
export async function deriveBalanceKey(signer: Signer, tokenAccount: string) {
  if (!signer.signMessage) throw new KeyInputUnavailableError("balance key")
  const signature = await signer.signMessage(balanceKeyMessage(tokenAccount))
  const digest = await crypto.subtle.digest(
    "SHA-256",
    Uint8Array.from(signature),
  )
  return base64FromBytes(new Uint8Array(digest).slice(0, 16))
}
