"use client"

import { queryOptions, useQuery } from "@tanstack/react-query"
import { api } from "@/lib/api"
import { queryKeys } from "./keys"

// Setup state only, no amount: it writes no audit row, so a screen may read it on open.
export const accountStatusOptions = () =>
  queryOptions({
    queryKey: queryKeys.status.me(),
    queryFn: ({ signal }) => api.me.status({ signal }),
  })

export function useAccountStatus() {
  return useQuery(accountStatusOptions())
}
