"use client"

import {
  queryOptions,
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query"
import { toast } from "sonner"
import { api } from "@/lib/api"
import type { ApiClient } from "@/lib/api/client"
import { isApiError, messageFor } from "@/lib/api/errors"
import {
  isKnownAuditorStatus,
  knownAuditorStatus,
  type Auditor,
  type AuditorStatus,
} from "@/lib/api/schemas"
import { removalCopy, removalKind, type RemovalKind } from "@/lib/auditors/copy"
import { queryKeys } from "./keys"

// An auditor as the screen shows it: a status the screen knows how to describe.
export type AuditorRow = Omit<Auditor, "status"> & {
  status: AuditorStatus
  // Set when the service sent a status this app does not know. The row shows as a
  // pending invite, but the sentences that name who can read amounts count it as a
  // reader (`hasActiveAuditor`), so they never leave one out.
  unrecognized?: true
}

export type AuditorList = {
  rows: AuditorRow[]
  // The page cap stopped the read, so the screen must say the list is partial.
  truncated: boolean
}

// The contract documents 50 and no maximum.
export const PAGE_SIZE = 50
// A company has a handful of auditors. The cap only stops a cursor that never ends.
export const MAX_PAGES = 20
// The client has no timeout of its own, and a dialog waits for these.
export const MUTATION_TIMEOUT_MS = 30_000
const LOOKUP_TIMEOUT_MS = 10_000

export async function listAllAuditors(
  client: ApiClient,
  signal?: AbortSignal,
): Promise<AuditorList> {
  const byId = new Map<string, AuditorRow>()
  let cursor: string | undefined
  let more = false
  for (let pages = 0; pages < MAX_PAGES; pages++) {
    const page = await client.company.auditors.list(
      { limit: PAGE_SIZE, cursor },
      { signal },
    )
    for (const item of page.items) {
      byId.set(item.id, {
        ...item,
        status: knownAuditorStatus(item.status),
        ...(isKnownAuditorStatus(item.status) ? {} : { unrecognized: true }),
      })
    }
    // A cursor that does not move would read the same page for ever.
    more = !!page.next_cursor && page.next_cursor !== cursor
    if (!more) break
    cursor = page.next_cursor ?? undefined
  }
  return { rows: [...byId.values()], truncated: more }
}

export function auditorsQuery(client: ApiClient) {
  return queryOptions({
    queryKey: queryKeys.auditors.list(),
    queryFn: ({ signal }) => listAllAuditors(client, signal),
  })
}

// A timed-out request is not an ApiError, but asking again is still the right offer.
export const canRetry = (error: unknown) =>
  !isApiError(error) || error.isRetryable

// The list on screen was out of date: the answer says what is really there.
const staleListCodes = [
  "auditor_already_invited",
  "auditor_already_active",
  "auditor_not_found",
]

// Not awaited by the mutations: a dialog waits for the answer to its own request,
// not for the list to be read again, which can take many requests.
function refresh(queryClient: QueryClient) {
  void queryClient.invalidateQueries({ queryKey: queryKeys.auditors.all })
}

// The toasts live here, not in the component that called `mutate`: a dialog the
// admin closes mid-request has unmounted by the time the answer arrives, and
// callbacks passed to `mutate` die with it.
export function inviteAuditorMutation(
  client: ApiClient,
  queryClient: QueryClient,
) {
  return {
    mutationFn: (email: string) =>
      client.company.auditors.invite(email, {
        signal: AbortSignal.timeout(MUTATION_TIMEOUT_MS),
      }),
    onSuccess: (_auditor: Auditor, email: string) => {
      toast.success(`Invite sent to ${email}`)
      refresh(queryClient)
    },
    onError: (error: Error) => {
      if (isApiError(error) && staleListCodes.includes(error.code)) {
        refresh(queryClient)
      }
    },
  }
}

export function revokeAuditorMutation(
  client: ApiClient,
  queryClient: QueryClient,
) {
  return {
    mutationFn: async (
      auditor: AuditorRow,
    ): Promise<{ status: RemovalKind }> => {
      // What the row is now, not when it was clicked: an invite may have been
      // accepted since, and then it is access that is revoked. Best effort.
      let status = removalKind(auditor)
      try {
        const list = await listAllAuditors(
          client,
          AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
        )
        queryClient.setQueryData(queryKeys.auditors.list(), list)
        const current = list.rows.find((row) => row.id === auditor.id)
        if (current) status = removalKind(current)
      } catch {
        // The revoke below reports whatever is really wrong.
      }
      await client.company.auditors.revoke(auditor.id, {
        signal: AbortSignal.timeout(MUTATION_TIMEOUT_MS),
      })
      return { status }
    },
    onSuccess: (result: { status: RemovalKind }, auditor: AuditorRow) => {
      toast.success(`${removalCopy(result.status).done} ${auditor.email}`)
      refresh(queryClient)
    },
    // Someone else already removed it: the list is wrong, not the request.
    onError: (error: Error) => {
      if (isApiError(error) && staleListCodes.includes(error.code)) {
        refresh(queryClient)
        if (error.code === "auditor_not_found") toast.error(messageFor(error))
      }
    },
  }
}

export function useAuditors() {
  return useQuery(auditorsQuery(api))
}

export function useInviteAuditor() {
  const queryClient = useQueryClient()
  return useMutation(inviteAuditorMutation(api, queryClient))
}

export function useRevokeAuditor() {
  const queryClient = useQueryClient()
  return useMutation(revokeAuditorMutation(api, queryClient))
}
