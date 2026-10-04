import {
  infiniteQueryOptions,
  queryOptions,
  type QueryClient,
} from "@tanstack/react-query"
import type { ApiClient } from "@/lib/api/client"
import type { SignStep } from "@/lib/api/sign"
import { applyPending, type ApplyPendingDeps } from "@/lib/me/apply-pending"
import { datedFilename } from "@/lib/download"
import { invalidateBalances } from "./invalidate"
import { queryKeys } from "./keys"

// The recipient's queries, written against a client so tests can hand them one
// without the app's mode check. The hooks in `me.ts` bind them to `api`.
export const RECENT_PAYMENTS = 5
export const HISTORY_PAGE_SIZE = 20

type MeClient = Pick<ApiClient, "me">

export function meQueries(client: MeClient) {
  return {
    status: () =>
      queryOptions({
        queryKey: queryKeys.status.me(),
        queryFn: ({ signal }) => client.me.status({ signal }),
      }),
    // The home page and the history page differ by `limit`, so they never share a
    // cache entry even though one is a list and the other pages.
    recent: () =>
      queryOptions({
        queryKey: queryKeys.payments.me({ limit: RECENT_PAYMENTS }),
        queryFn: ({ signal }) =>
          client.me.payments({ limit: RECENT_PAYMENTS }, { signal }),
      }),
    history: () =>
      infiniteQueryOptions({
        queryKey: queryKeys.payments.me({ limit: HISTORY_PAGE_SIZE }),
        initialPageParam: undefined as string | undefined,
        queryFn: ({ pageParam, signal }) =>
          client.me.payments(
            { limit: HISTORY_PAGE_SIZE, cursor: pageParam },
            { signal },
          ),
        getNextPageParam: (page) => page.next_cursor ?? undefined,
      }),
  }
}

// The save and the toast live here, not in the screen: a screen that was left
// mid-request still gets its file.
export function exportPaymentsMutation({
  exports,
  save,
  notify,
  now = () => new Date(),
}: {
  exports: Pick<ApiClient["exports"], "me">
  save: (blob: Blob, filename: string) => void
  notify: (message: string) => void
  now?: () => Date
}) {
  return {
    mutationFn: () => exports.me(),
    onSuccess: (blob: Blob) => {
      const filename = datedFilename("cadence-payments", "csv", now())
      save(blob, filename)
      notify(`Saved ${filename}`)
    },
  }
}

// Side effects live here, not in the component, so leaving the page while the
// transaction confirms still refreshes the balance and tells the person.
export function applyPendingMutation({
  queryClient,
  onStep,
  onApplied,
  ...deps
}: ApplyPendingDeps & {
  queryClient: QueryClient
  onStep?: (step: SignStep) => void
  onApplied?: () => void
}) {
  return {
    mutationFn: () => applyPending(deps, onStep),
    onSuccess: async () => {
      onApplied?.()
      await Promise.all([
        invalidateBalances(queryClient),
        queryClient.invalidateQueries({ queryKey: queryKeys.status.all }),
      ])
    },
  }
}
