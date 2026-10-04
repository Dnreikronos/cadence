import type { ShellBalance } from "@/components/app/app-shell"
import { isSignedOut } from "@/lib/api/error-action"
import { unitsToUsd } from "@/lib/money"

export type BalanceQuery = {
  data?: { available: string }
  error?: unknown
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
  // A signed-out answer is the screen's to explain (it offers "Sign in"); a second
  // alert in the sidebar would only nag.
  if (query.isError && isSignedOut(query.error)) return { state: "hidden" }
  if (query.isError && !query.isFetching) {
    return { state: "hidden", error: true, onRetry: () => query.refetch() }
  }
  return { state: "loading" }
}
