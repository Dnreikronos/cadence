"use client"

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"
import { api } from "@/lib/api"
import type { RunRequest } from "@/lib/api/schemas"
import { listPeople } from "@/lib/people/mock"
import { inviteMessage } from "@/lib/runs/messages"
import { collectPages } from "@/lib/runs/pages"
import { withAmounts, type PayrollPerson } from "@/lib/runs/plan"
import { isApiError } from "@/lib/api/errors"
import { queryKeys, type ViewerScope } from "./keys"

// The people a payroll run can pay, with the amount the proof service holds for each.
//
// TEMPORARY. Task A (#81) replaces `lib/people/mock` with a `PeopleRepository`, whose
// mock ids are the proof service's own. Until it is on main this adapter reads the
// legacy mock and maps its ids onto those of the mock service. When A merges, this
// function becomes `repository.list()` and the id table below goes away; nothing else
// in the run screens changes.
const proofServiceIds: Record<string, string> = {
  p1: "a0000000-0000-4000-8000-000000000001",
  p2: "a0000000-0000-4000-8000-000000000002",
  p3: "a0000000-0000-4000-8000-000000000003",
  p4: "a0000000-0000-4000-8000-000000000004",
}

async function readPayrollPeople(
  signal: AbortSignal,
): Promise<PayrollPerson[]> {
  const [people, amounts] = await Promise.all([
    listPeople(),
    collectPages((cursor) =>
      api.company.amounts({ limit: 100, cursor }, { signal }),
    ),
  ])
  return withAmounts(
    people.map((person) => ({
      id: proofServiceIds[person.id] ?? person.id,
      name: person.name,
      email: person.email,
      kind: person.kind,
      activation: person.activation,
    })),
    new Map(amounts.map((row) => [row.person_id, row.amount])),
  )
}

// A key of its own under the people prefix: the people screen caches a different shape
// under `people.list()`, and a people mutation still reaches this one through `people.all`.
const payrollPeopleKey = [...queryKeys.people.all, "payroll"] as const

export function usePayrollPeople() {
  return useQuery({
    queryKey: payrollPeopleKey,
    queryFn: ({ signal }) => readPayrollPeople(signal),
  })
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

// Sends or resends the invite email. The toast lives here, not in the component, so
// it still shows if the row that asked for it is gone by the time the call returns.
export function useInviteRecipient() {
  return useMutation({
    mutationFn: (person: Pick<PayrollPerson, "id" | "name">) =>
      api.company.invite(person.id),
    onSuccess: (_, person) => toast.success(`Invite sent to ${person.name}`),
    onError: (error, person) =>
      toast.error(`Couldn't invite ${person.name}`, {
        description: inviteMessage(error),
      }),
  })
}
