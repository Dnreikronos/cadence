import type { QueryClient } from "@tanstack/react-query"
import type { AccountStatus } from "@/lib/api/schemas"
import { invalidateBalances } from "@/lib/queries/invalidate"
import { queryKeys } from "@/lib/queries/keys"

// After the last step: /me must see an activated account when it opens, even if the
// confirming read is slow, so the cache is set first and the service is asked to agree.
export async function settleActivated(queryClient: QueryClient) {
  queryClient.setQueryData<AccountStatus>(queryKeys.status.me(), (old) => ({
    pending_credits: false,
    ...old,
    wallet_linked: true,
    key_enrolled: true,
    account_configured: true,
  }))
  // A balance that could not be read before the account existed can be now.
  await Promise.allSettled([
    queryClient.invalidateQueries({ queryKey: queryKeys.status.me() }),
    invalidateBalances(queryClient),
  ])
}
