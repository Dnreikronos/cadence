import type { ShellBalance } from "@/components/app/app-shell"
import { unitsToUsd } from "@/lib/money"

export type BalanceQuery = {
  data?: { available: string }
  isError: boolean
  isFetching: boolean
  refetch: () => unknown
}

// What the sidebar card shows for a query's state. A balance already on screen
// stays there while it refreshes, or when a refresh fails.
export function shellBalanceOf(query: BalanceQuery): ShellBalance {
  if (query.data) {
    return { amount: unitsToUsd(query.data.available), state: "revealed" }
  }
  if (query.isError && !query.isFetching) {
    return { state: "hidden", error: true, onRetry: () => query.refetch() }
  }
  return { state: "loading" }
}
