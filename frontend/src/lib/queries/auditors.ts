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
import { isApiError } from "@/lib/api/errors"
import {
  knownAuditorStatus,
  type Auditor,
  type AuditorStatus,
} from "@/lib/api/schemas"
import { removalCopy } from "@/lib/auditors/copy"
import { queryKeys } from "./keys"

// An auditor as the screen shows it: a status the screen knows how to describe.
export type AuditorRow = Omit<Auditor, "status"> & { status: AuditorStatus }

const PAGE_SIZE = 100
// A company has a handful of auditors. The cap only stops a cursor that never ends.
const MAX_PAGES = 20

export async function listAllAuditors(
  client: ApiClient,
  signal?: AbortSignal,
): Promise<AuditorRow[]> {
  const rows: AuditorRow[] = []
  let cursor: string | undefined
  for (let pages = 0; pages < MAX_PAGES; pages++) {
    const page = await client.company.auditors.list(
      { limit: PAGE_SIZE, cursor },
      { signal },
    )
    for (const item of page.items) {
      rows.push({ ...item, status: knownAuditorStatus(item.status) })
    }
    if (!page.next_cursor) break
    cursor = page.next_cursor
  }
  return rows
}

export function auditorsQuery(client: ApiClient) {
  return queryOptions({
    queryKey: queryKeys.auditors.list(),
    queryFn: ({ signal }) => listAllAuditors(client, signal),
  })
}

// The toasts live here, not in the component that called `mutate`: a dialog the
// admin closes mid-request has unmounted by the time the answer arrives, and
// callbacks passed to `mutate` die with it.
export function inviteAuditorMutation(
  client: ApiClient,
  queryClient: QueryClient,
) {
  return {
    mutationFn: (email: string) => client.company.auditors.invite(email),
    onSuccess: (_auditor: Auditor, email: string) => {
      toast.success(`Invite sent to ${email}`)
      return queryClient.invalidateQueries({
        queryKey: queryKeys.auditors.all,
      })
    },
  }
}

export function revokeAuditorMutation(
  client: ApiClient,
  queryClient: QueryClient,
) {
  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: queryKeys.auditors.all })
  return {
    mutationFn: (auditor: AuditorRow) =>
      client.company.auditors.revoke(auditor.id),
    onSuccess: (_result: unknown, auditor: AuditorRow) => {
      toast.success(`${removalCopy(auditor.status).done} ${auditor.email}`)
      return refresh()
    },
    // Someone else already removed it: the list is wrong, not the request.
    onError: (error: Error) =>
      isApiError(error) && error.code === "auditor_not_found"
        ? refresh()
        : undefined,
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
