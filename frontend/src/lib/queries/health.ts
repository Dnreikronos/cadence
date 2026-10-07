"use client"

import { type QueryState, queryOptions, useQuery } from "@tanstack/react-query"
import { api } from "@/lib/api"
import { isApiError } from "@/lib/api/errors"
import type { Health } from "@/lib/api/schemas"
import { queryKeys } from "./keys"

// `down`: the service does not answer (or the browser is offline). `failing`: it answers,
// with an error of its own. `degraded`: it answers but cannot reach the Solana network,
// so balances and payments fail anyway.
export type ServiceStatus = "down" | "failing" | "degraded"

// What both a `useQuery` result and the cached `query.state` carry.
export type HealthQuery = Pick<QueryState<Health>, "data" | "error" | "status">

// What the shell says about the last health check, or null to say nothing. A failed
// check wins over an older ok answer still in the cache.
export function serviceStatusOf({
  data,
  error,
  status,
}: HealthQuery): ServiceStatus | null {
  if (status === "error" && isApiError(error)) {
    // Unreachable, as the rest of the app reads it: a dropped connection, or a proxy
    // answering while the service restarts. A 429 is retryable too, but it is the
    // service answering "later", not an outage.
    if (error.isRetryable && error.status !== 429) return "down"
    if (error.status >= 500) return "failing"
  }
  // Nothing new (a 429, a 4xx, a drifted body): the last answer, if any, still stands.
  if (!data) return null
  return data.status === "unavailable" || !data.rpc_reachable
    ? "degraded"
    : null
}

// Checked again sooner while something is wrong, so the notice goes once it is fixed.
export const healthPollMs = (status: ServiceStatus | null) =>
  status ? 15_000 : 60_000

export const healthOptions = () =>
  queryOptions({
    queryKey: queryKeys.health.all,
    queryFn: ({ signal }) => api.health({ signal }),
    refetchInterval: (query) => healthPollMs(serviceStatusOf(query.state)),
    // The interval pauses in a hidden tab, and the app turns focus refetches off: this
    // check is cheap and not rate-limited, so a returning tab is not left on a stale
    // notice for up to a minute.
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
  })

export function useServiceStatus() {
  return serviceStatusOf(useQuery(healthOptions()))
}
