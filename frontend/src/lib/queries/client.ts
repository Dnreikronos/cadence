import { QueryClient } from "@tanstack/react-query"
import { isApiError } from "@/lib/api/errors"

// One retry for a hiccup. A 4xx will answer the same way again, so it is shown at once.
export function shouldRetry(failureCount: number, error: unknown): boolean {
  if (isApiError(error) && error.status >= 400 && error.status < 500) {
    return false
  }
  return failureCount < 1
}

// The app's only QueryClient is built here, so every screen shares these defaults.
export function makeQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        retry: shouldRetry,
        refetchOnWindowFocus: false,
      },
    },
  })
}
