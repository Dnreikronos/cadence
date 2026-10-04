import type { QueryClient } from "@tanstack/react-query"
import { queryKeys } from "./keys"

// The sidebar balance stays mounted and does not refetch on focus, so anything that
// moves money must call this when it succeeds, or the shell keeps showing the old amount.
export function invalidateBalances(queryClient: QueryClient) {
  return queryClient.invalidateQueries({ queryKey: queryKeys.balance.all })
}
