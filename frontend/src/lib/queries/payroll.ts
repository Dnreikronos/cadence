"use client"

import { useMemo } from "react"
import {
  queryOptions,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query"
import { api, currentUserId } from "@/lib/api"
import { isApiError } from "@/lib/api/errors"
import { isKnownRunPaymentStatus } from "@/lib/api/schemas"
import type { Signer } from "@/lib/api/sign"
import { createRun } from "@/lib/runs/create"
import { readAllByPerson, type AmountsRead } from "@/lib/people/amounts"
import { readRecentlyPaid } from "@/lib/runs/recent"
import { withAmounts, type PayrollPerson } from "@/lib/runs/plan"
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

// Each person's token account (proposed, API_CONTRACT Q36), by person id. A person
// without one has not configured an account and cannot be paid yet.
export function useRecipientAccounts() {
  return useQuery<AmountsRead>({
    queryKey: queryKeys.people.accounts(),
    queryFn: ({ signal }) =>
      readAllByPerson(
        (cursor) =>
          api.company.recipientAccounts({ cursor, limit: 100 }, { signal }),
        (item) => item.token_account,
      ),
  })
}

// An amount from a failed refresh is not used: paying a figure that may be out of date
// is worse than not paying yet, so a failure of any read is an error here.
export function usePayrollPeople(): PayrollPeople {
  const people = usePeople()
  const amounts = usePersonAmounts()
  const accounts = useRecipientAccounts()
  const failed = people.isError || amounts.isError || accounts.isError
  const list = people.data
  const read = amounts.data
  const where = accounts.data
  const data = useMemo(
    () =>
      !failed && list && read && where
        ? withAmounts(
            list.people,
            new Map(Object.entries(read.byPerson)),
            new Map(Object.entries(where.byPerson)),
          )
        : undefined,
    [failed, list, read, where],
  )
  return {
    data,
    isPending: !data && !failed,
    isError: !data && failed,
    error: people.error ?? amounts.error ?? accounts.error,
    isFetching: people.isFetching || amounts.isFetching || accounts.isFetching,
    truncated: Boolean(list?.truncated || read?.truncated || where?.truncated),
    refetch: () => {
      void people.refetch()
      void amounts.refetch()
      void accounts.refetch()
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

// Who was paid in the last 24 hours, from the company's payments (newest first), read
// fresh each time the new-run page opens: it is what keeps a second run from paying the
// same people twice. Under the `payments` prefix, so a confirmed payment refreshes it.
// More payments than five pages hold inside the window is an error, not a partial answer.
export function useRecentlyPaid() {
  return useQuery({
    queryKey: [...queryKeys.payments.all, "recently-paid"],
    refetchOnMount: "always",
    queryFn: ({ signal }) =>
      readRecentlyPaid(
        (cursor) => api.company.payments({ limit: 100, cursor }, { signal }),
        Date.now(),
      ),
  })
}

// The indexer can resolve a payment while this browser is idle or disconnected.
export const runOptions = (runId: string) =>
  queryOptions({
    queryKey: queryKeys.runs.detail(runId),
    queryFn: ({ signal }) => api.runs.get(runId, { signal }),
    refetchInterval: (query) => {
      if (!query.state.data) {
        return isApiError(query.state.error) && query.state.error.isRetryable
          ? 5_000
          : false
      }
      return query.state.data.payments.some(
        (payment) =>
          payment.status === "prepared" ||
          !isKnownRunPaymentStatus(payment.status),
      )
        ? 5_000
        : false
    },
    refetchOnMount: "always",
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
  })

export function useRun(runId: string) {
  return useQuery(runOptions(runId))
}

// Creating a run moves no money: its transactions are unsigned, and a run whose answer
// was lost can never pay anyone. Someone may have changed since the list was read.
export function useCreateRun() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({
      signer,
      recipients,
    }: {
      signer: Signer
      recipients: readonly PayrollPerson[]
    }) =>
      createRun(signer, recipients, {
        create: (request) => api.runs.create(request),
        userId: currentUserId,
      }),
    onSettled: (_, error) => {
      if (error) {
        void queryClient.invalidateQueries({ queryKey: queryKeys.people.all })
      }
    },
  })
}
