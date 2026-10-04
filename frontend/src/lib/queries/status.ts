"use client"

import { queryOptions, useQuery } from "@tanstack/react-query"
import { api } from "@/lib/api"
import { queryKeys, type ViewerScope } from "./keys"

// Setup state only, no amount: it writes no audit row, so a screen may read it on open.
// Per viewer, like the balances, so one person's status is never read as another's.
export const accountStatusOptions = (viewer: ViewerScope) =>
  queryOptions({
    queryKey: queryKeys.status.me(viewer),
    queryFn: ({ signal }) => api.me.status({ signal }),
  })

export function useAccountStatus(viewer: ViewerScope, enabled = true) {
  return useQuery({ ...accountStatusOptions(viewer), enabled })
}
