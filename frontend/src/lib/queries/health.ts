"use client"

import { queryOptions, useQuery } from "@tanstack/react-query"
import { api } from "@/lib/api"
import { isApiError } from "@/lib/api/errors"
import type { Health } from "@/lib/api/schemas"
import { queryKeys } from "./keys"

// `down`: the service does not answer (or the browser is offline). `degraded`: it answers
// but cannot reach the Solana network, so balances and payments fail anyway.
export type ServiceStatus = "down" | "degraded"

export type HealthQuery = { data?: Health; error?: unknown; isError: boolean }

// What the shell says about the last health check, or null to say nothing. A failed
// check wins over an older ok answer still in the cache.
export function serviceStatusOf(query: HealthQuery): ServiceStatus | null {
  if (query.isError) {
    const error = query.error
    // Anything else (a drifted body, a 4xx) means the service answered.
    return isApiError(error) && (error.status === 0 || error.status >= 500)
      ? "down"
      : null
  }
  if (!query.data) return null
  return query.data.status === "unavailable" || !query.data.rpc_reachable
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
    refetchInterval: ({ state }) =>
      healthPollMs(
        serviceStatusOf({
          data: state.data,
          error: state.error,
          isError: state.status === "error",
        }),
      ),
  })

export function useServiceStatus() {
  return serviceStatusOf(useQuery(healthOptions()))
}
