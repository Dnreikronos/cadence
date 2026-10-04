"use client"

import { useMemo } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { api } from "@/lib/api"
import type { RunRequest } from "@/lib/api/schemas"
import { collectPages } from "@/lib/runs/pages"
import {
  recentWindowMs,
  recentlyPaidIds,
  withAmounts,
  type PayrollPerson,
} from "@/lib/runs/plan"
import { isApiError } from "@/lib/api/errors"
import { queryKeys, type ViewerScope } from "./keys"
import { usePeople, usePersonAmounts } from "./people"

// What the payroll screens read about people: the people table (name, email, kind,
// whether they have an account) from main's repository, joined by person id with the
// amounts the proof service holds. One answer, in the shape of a query.
export type PayrollPeople = {
  data: PayrollPerson[] | undefined
  isPending: boolean
  isError: boolean
  error: unknown
  isFetching: boolean
  // More people, or more amounts, exist than were read: the run may be missing someone.
  truncated: boolean
  refetch: () => void
}

// An amount from a failed refresh is not used: paying a figure that may be out of date
// is worse than not paying yet, so a failure of either read is an error here.
export function usePayrollPeople(): PayrollPeople {
  const people = usePeople()
  const amounts = usePersonAmounts()
  const failed = people.isError || amounts.isError
  const list = people.data
  const read = amounts.data
  const data = useMemo(
    () =>
      !failed && list && read
        ? withAmounts(list.people, new Map(Object.entries(read.byPerson)))
        : undefined,
    [failed, list, read],
  )
  return {
    data,
    isPending: !data && !failed,
    isError: !data && failed,
    error: people.error ?? amounts.error,
    isFetching: people.isFetching || amounts.isFetching,
    truncated: Boolean(list?.truncated || read?.truncated),
    refetch: () => {
      void people.refetch()
      void amounts.refetch()
    },
  }
}

// The same key as the sidebar, so the two share one cached balance.
export function useCompanyBalance(viewer: ViewerScope) {
  return useQuery({
    queryKey: queryKeys.balance.company(viewer),
    queryFn: ({ signal }) => api.company.balance({ signal }),
  })
}

export function useRecentPayments(limit: number) {
  return useQuery({
    queryKey: queryKeys.payments.company({ limit }),
    queryFn: ({ signal }) => api.company.payments({ limit }, { signal }),
  })
}

const recentPages = 5

// Who was paid in the last 24 hours, from the company's payments (newest first), read
// fresh each time the new-run page opens: it is what keeps a second run from paying the
// same people twice. Under the `payments` prefix, so a confirmed payment refreshes it.
export function useRecentlyPaid() {
  return useQuery({
    queryKey: [...queryKeys.payments.all, "recently-paid"],
    refetchOnMount: "always",
    queryFn: async ({ signal }) => {
      const now = Date.now()
      const payments = await collectPages(
        (cursor) => api.company.payments({ limit: 100, cursor }, { signal }),
        recentPages,
        // Newest first: a page that ends before the window has nothing more to add.
        (page) =>
          page.length > 0 &&
          Date.parse(page[page.length - 1].paid_at) < now - recentWindowMs,
      )
      return recentlyPaidIds(payments, now)
    },
  })
}

const runPollMs = 5_000

// The run's payments, without amounts. Asks again while any payment is still open, so
// a run started elsewhere (or confirmed by the network later) catches up.
export function useRun(runId: string) {
  return useQuery({
    queryKey: queryKeys.runs.detail(runId),
    queryFn: ({ signal }) => api.runs.get(runId, { signal }),
    refetchInterval: (query) => {
      const run = query.state.data
      if (!run || query.state.status === "error") return false
      const open = run.payments.some(
        (payment) =>
          payment.status === "pending" || payment.status === "signed",
      )
      return open ? runPollMs : false
    },
  })
}

// Creating a run moves no money: the payments are signed one by one afterwards.
// The idempotency key is the caller's, so the same attempt never makes two runs.
export function useCreateRun() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (request: RunRequest) => api.runs.create(request),
    onError: (error) => {
      // Someone's status changed since the list was read.
      if (isApiError(error) && error.code === "recipient_not_activated") {
        void queryClient.invalidateQueries({ queryKey: queryKeys.people.all })
      }
    },
  })
}
