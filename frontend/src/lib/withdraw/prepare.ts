import { UnexpectedSignerError, type Signer } from "@/lib/api/sign"
import type { UnwrapPrepared, UnwrapRequest } from "@/lib/api/schemas"
import {
  deriveBalanceKey,
  sendLinkingWallet,
  senderAccountFor,
} from "@/lib/runs/keys"

// What the withdraw screen asks for: everything but the keys, which are added here.
export type UnwrapAsk = Omit<UnwrapRequest, "aes_key" | "wallet_signature">

export type PrepareUnwrapDeps = {
  prepare: (request: UnwrapRequest) => Promise<UnwrapPrepared>
  userId: () => Promise<string | null>
  senderAccount?: (wallet: string) => Promise<string>
  balanceKey?: (signer: Signer, account: string) => Promise<string>
}

// Prepares a withdrawal with the balance key of the account it draws on, from the same
// seams a payroll run uses (`runs/keys.ts`): made up in demo mode, refused in real mode.
// The key is derived for each ask and kept in memory only. The wallet is linked on its
// first unwrap (`sendLinkingWallet`). The key and the link are both the signer's, so an
// ask for any other wallet is refused before anything is signed.
export async function prepareUnwrap(
  signer: Signer,
  ask: UnwrapAsk,
  {
    prepare,
    userId,
    senderAccount = senderAccountFor,
    balanceKey = deriveBalanceKey,
  }: PrepareUnwrapDeps,
): Promise<UnwrapPrepared> {
  if (ask.wallet !== signer.address) throw new UnexpectedSignerError()
  const account = await senderAccount(signer.address)
  const request = { ...ask, aes_key: await balanceKey(signer, account) }
  return (await sendLinkingWallet(signer, request, prepare, userId)).answer
}
