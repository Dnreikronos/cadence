import { isApiError } from "@/lib/api/errors"
import type { Signer } from "@/lib/api/sign"
import type { Run, RunRequest } from "@/lib/api/schemas"
import { buildRunRequest, type PayrollPerson } from "./plan"
import {
  RunInputUnavailableError,
  deriveBalanceKey,
  senderAccountFor,
  walletLinkSignature,
} from "./keys"

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

// Builds the request and creates the run. The first run of a wallet is refused with
// `wallet_link_required`: the wallet then signs the link text and the same request is
// sent once more with it. Nothing here moves money: the transactions come back unsigned.
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
  try {
    return { request, run: await create(request), aesKey, recipients }
  } catch (error) {
    if (!(isApiError(error) && error.code === "wallet_link_required")) {
      throw error
    }
  }
  const user = await userId()
  if (!user) throw new RunInputUnavailableError("user")
  const linked = {
    ...request,
    wallet_signature: await walletLinkSignature(signer, user),
  }
  return { request: linked, run: await create(linked), aesKey, recipients }
}
