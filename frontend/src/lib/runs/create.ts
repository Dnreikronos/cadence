import type { Signer } from "@/lib/api/sign"
import type { Run, RunRequest } from "@/lib/api/schemas"
import { buildRunRequest, type PayrollPerson } from "./plan"
import { deriveBalanceKey, sendLinkingWallet, senderAccountFor } from "./keys"

export type CreateRunDeps = {
  create: (request: RunRequest) => Promise<Run>
  userId: () => Promise<string | null>
  senderAccount?: (wallet: string) => Promise<string>
  balanceKey?: (signer: Signer, sender: string) => Promise<string>
}

// What a created run needs to be signed and retried: the request (who each position
// is, and the amounts that were approved) and the balance key, kept in memory only.
// `recipients[i]` is who position i pays.
export type CreatedRun = {
  request: RunRequest
  run: Run
  aesKey: string
  recipients: readonly PayrollPerson[]
}

// Builds the request and creates the run, linking the wallet on its first run
// (`sendLinkingWallet`). Nothing here moves money: the transactions come back unsigned.
export async function createRun(
  signer: Signer,
  recipients: readonly PayrollPerson[],
  {
    create,
    userId,
    senderAccount = senderAccountFor,
    balanceKey = deriveBalanceKey,
  }: CreateRunDeps,
): Promise<CreatedRun> {
  const sender = await senderAccount(signer.address)
  const aesKey = await balanceKey(signer, sender)
  const request = buildRunRequest(signer.address, sender, aesKey, recipients)
  const sent = await sendLinkingWallet(signer, request, create, userId)
  return { request: sent.request, run: sent.answer, aesKey, recipients }
}
