import {
  infiniteQueryOptions,
  queryOptions,
  type QueryClient,
} from "@tanstack/react-query"
import type { ApiClient } from "@/lib/api/client"
import type { Receipt } from "@/lib/api/schemas"
import { datedFilename } from "@/lib/download"
import {
  applyPending,
  ApplyInProgressError,
  SentApplyError,
  type ApplyPendingDeps,
  type ApplyPhase,
} from "@/lib/me/apply-pending"
import { sentApply } from "@/lib/me/last-apply"
import type { Confirmed } from "@/lib/me/settle"
import { invalidateBalances } from "./invalidate"
import { queryKeys } from "./keys"

// The recipient's queries, written against a client so tests can hand them one
// without the app's mode check. The hooks in `me.ts` bind them to `api`.
export const RECENT_PAYMENTS = 5
export const HISTORY_PAGE_SIZE = 20

type MeClient = Pick<ApiClient, "me">

export function meQueries(client: MeClient) {
  return {
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

export const applyKey = ["apply-pending"] as const

// One apply at a time per client, checked and taken in the same synchronous step.
const applying = new WeakSet<QueryClient>()

// The apply of pending credits. Its side effects live here, not in the component,
// so leaving the page while it confirms still refreshes the balance and tells the
// person.
export function applyPendingMutation({
  queryClient,
  onPhase,
  onApplied,
  onSent,
  now = Date.now,
  ...deps
}: ApplyPendingDeps & {
  queryClient: QueryClient
  onPhase?: (phase: ApplyPhase) => void
  onApplied?: () => void
  // The apply may have gone through: told even when the screen is gone.
  onSent?: (error: SentApplyError) => void
}) {
  return {
    mutationKey: applyKey,
    // Never prepare and sign again by itself, whatever the app's mutation default.
    retry: false as const,
    mutationFn: async ({
      pendingBefore,
    }: {
      pendingBefore: string
    }): Promise<{ receipt: Receipt; confirmed: Confirmed }> => {
      // A second press, or an apply sent earlier and not seen through: neither
      // may prepare another transaction.
      if (
        applying.has(queryClient) ||
        sentApply(deps.store, deps.wallet.address)
      ) {
        throw new ApplyInProgressError()
      }
      applying.add(queryClient)
      try {
        const receipt = await applyPending({ ...deps, now }, onPhase)
        return {
          receipt,
          confirmed: { pendingBefore, slot: receipt.slot, at: now() },
        }
      } finally {
        applying.delete(queryClient)
      }
    },
    // `void`: the money has moved, so the screen must not wait on a refetch.
    onSuccess: () => {
      onApplied?.()
      void invalidateBalances(queryClient)
      void queryClient.invalidateQueries({ queryKey: queryKeys.status.all })
    },
    onError: (error: Error) => {
      if (error instanceof ApplyInProgressError) return
      // The service compares the credit counter after the first apply, so a failure
      // can be an apply that landed: the balance is worth a fresh read either way.
      void invalidateBalances(queryClient)
      void queryClient.invalidateQueries({ queryKey: queryKeys.status.all })
      if (error instanceof SentApplyError) onSent?.(error)
    },
  }
}
