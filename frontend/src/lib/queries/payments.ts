"use client"

import {
  infiniteQueryOptions,
  useInfiniteQuery,
  useMutation,
  useQuery,
} from "@tanstack/react-query"
import { toast } from "sonner"
import { api } from "@/lib/api"
import { auditorStatuses, type Auditor } from "@/lib/api/schemas"
import { datedFilename, saveBlob } from "@/lib/download"
import { queryKeys } from "./keys"

export const paymentsPageSize = 25

// The service pages with an opaque cursor; null means the last page.
export function nextCursor(page: { next_cursor: string | null }) {
  return page.next_cursor ?? undefined
}

export function companyPaymentsOptions() {
  return infiniteQueryOptions({
    queryKey: queryKeys.payments.company({ limit: paymentsPageSize }),
    queryFn: ({ pageParam, signal }) =>
      api.company.payments(
        { limit: paymentsPageSize, cursor: pageParam },
        { signal },
      ),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: nextCursor,
  })
}

// Every payment the company made, newest first, a page at a time.
export function useCompanyPayments() {
  return useInfiniteQuery(companyPaymentsOptions())
}

// The save and the toast live here, not in the screen: a screen that was left
// mid-request still gets its file.
export function companyExportOptions(
  save: typeof saveBlob = saveBlob,
  notify: (message: string) => void = (message) => toast.success(message),
) {
  return {
    mutationFn: () => api.exports.company(),
    onSuccess: (blob: Blob) => {
      const filename = datedFilename("cadence-payments", "csv")
      save(blob, filename)
      notify(`Saved ${filename}`)
    },
  }
}

export function useCompanyExport() {
  return useMutation(companyExportOptions())
}

// Whether some auditor can read the company's amounts: a status the app does not
// know counts as one, since the sentence that names the readers must not leave one out.
export function hasActiveAuditor(auditors: readonly Pick<Auditor, "status">[]) {
  return auditors.some(
    ({ status }) =>
      status === "active" ||
      !(auditorStatuses as readonly string[]).includes(status),
  )
}

// True or false once known, undefined while loading or after a failure (or when
// the first page cannot say): callers then use the longer, safe sentence.
// A thin read for the receipts screen; the auditors screen's own hooks (#118)
// can replace it.
export function useHasAuditor(): boolean | undefined {
  const query = useQuery({
    queryKey: [...queryKeys.auditors.all, "has-active"],
    queryFn: async ({ signal }) => {
      const page = await api.company.auditors.list({ limit: 100 }, { signal })
      if (hasActiveAuditor(page.items)) return true
      return page.next_cursor === null ? false : null
    },
  })
  return query.data ?? undefined
}
