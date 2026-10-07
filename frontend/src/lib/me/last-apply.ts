import type { ApiClient } from "@/lib/api/client"
import { reconcileWrap, type Reconciled } from "@/lib/deposit/reconcile"
import type { Submission } from "@/lib/submissions"

export type LastApplyStore = {
  read: () => Submission | null
  clear: () => void
}

// What the check of an apply sent earlier found, or "none" when nothing was sent.
export type LastApply = Reconciled | "none"

type Input = {
  store: LastApplyStore
  wallet: string
  accounts: Pick<ApiClient["accounts"], "confirmApplyPending">
  // Balances may have changed, whatever the answer was.
  refresh: () => void
  signal?: AbortSignal
  blockHeight?: Parameters<typeof reconcileWrap>[0]["blockHeight"]
  sleep?: Parameters<typeof reconcileWrap>[0]["sleep"]
  pollMs?: number
}

// The apply sent earlier for this wallet, if it was not seen through.
export function sentApply(store: LastApplyStore, wallet: string) {
  const record = store.read()
  return record && record.wallet === wallet ? record : null
}

// Finds out what became of the last apply by confirming it again, which the service
// answers idempotently for one signature: it never prepares anything new. The record
// is cleared once the answer is final (past its last valid block height a transaction
// can no longer land, the same rule as the deposit's wrap). A failure to ask keeps the record and throws,
// so the lock stays until the service can be reached.
export async function checkLastApply({
  store,
  wallet,
  accounts,
  refresh,
  signal,
  blockHeight,
  sleep,
  pollMs,
}: Input): Promise<LastApply> {
  const record = sentApply(store, wallet)
  if (!record) return "none"
  const outcome = await reconcileWrap({
    record,
    // Only the confirm call is read, and it is the apply's own.
    api: { wrap: { confirm: accounts.confirmApplyPending } },
    signal,
    blockHeight,
    sleep,
    pollMs,
  })
  store.clear()
  refresh()
  return outcome
}

// What the person reads once the check of their last update has ended.
export function lastApplyMessage(outcome: LastApply): string | null {
  switch (outcome) {
    case "confirmed":
      return "Your last update went through."
    case "failed":
      return "Your last update didn't go through. You can apply again."
    case "unknown":
      return "We couldn't tell whether your last update went through. The balance above is current."
    case "none":
      return null
  }
}
