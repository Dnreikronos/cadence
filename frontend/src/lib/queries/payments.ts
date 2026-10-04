"use client"

import {
  infiniteQueryOptions,
  useInfiniteQuery,
  useMutation,
} from "@tanstack/react-query"
import { toast } from "sonner"
import { api } from "@/lib/api"
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
