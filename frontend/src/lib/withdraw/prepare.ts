import { isApiError } from "@/lib/api/errors"
import type { Signer } from "@/lib/api/sign"
import type { UnwrapPrepared, UnwrapRequest } from "@/lib/api/schemas"
import {
  RunInputUnavailableError,
  deriveBalanceKey,
  senderAccountFor,
  walletLinkSignature,
} from "@/lib/runs/keys"

// What the withdraw screen asks for: everything but the keys, which are added here.
export type UnwrapAsk = Omit<UnwrapRequest, "aes_key" | "wallet_signature">

export type PrepareUnwrapDeps = {
  prepare: (request: UnwrapRequest) => Promise<UnwrapPrepared>
  userId: () => Promise<string | null>
  sourceAccount?: (wallet: string) => Promise<string>
  balanceKey?: (signer: Signer, account: string) => Promise<string>
}

// Prepares a withdrawal with the balance key of the account it draws on, from the same
// seams a payroll run uses (`runs/keys.ts`): made up in demo mode, refused in real mode.
// The key is derived for each ask and kept in memory only. The first unwrap of a wallet
// that is not linked yet is refused with `wallet_link_required`: the wallet then signs
// the link text and the same request is sent once more with it.
export async function prepareUnwrap(
  signer: Signer,
  ask: UnwrapAsk,
  {
    prepare,
    userId,
    sourceAccount = senderAccountFor,
    balanceKey = deriveBalanceKey,
  }: PrepareUnwrapDeps,
): Promise<UnwrapPrepared> {
  const account = await sourceAccount(ask.wallet)
  const request = { ...ask, aes_key: await balanceKey(signer, account) }
  try {
    return await prepare(request)
  } catch (error) {
    if (!(isApiError(error) && error.code === "wallet_link_required")) {
      throw error
    }
  }
  const user = await userId()
  if (!user) throw new RunInputUnavailableError("user")
  return prepare({
    ...request,
    wallet_signature: await walletLinkSignature(signer, user),
  })
}
