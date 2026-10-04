"use client"

import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query"
import { toast } from "sonner"
import { api } from "@/lib/api"
import { readAllAmounts } from "@/lib/people/amounts"
import {
  AmountNotSavedError,
  inviteMessageFor,
  isRetryablePeopleError,
  peopleMessageFor,
} from "@/lib/people/errors"
import { peopleRepository } from "@/lib/people/repository"
import {
  savePerson,
  sendInvite,
  type SavePersonRequest,
  type SavePersonResult,
} from "@/lib/people/service"
import type { PersonRecord } from "@/lib/people/types"
import { queryKeys } from "./keys"

// The people table: names, emails, kinds and who has an account.
export function usePeople() {
  return useQuery({
    queryKey: queryKeys.people.list(),
    queryFn: async () => (await peopleRepository()).list(),
  })
}

// What each person is paid, from the proof service. A separate query, so the
// people stay on screen when only the amounts fail.
export function usePersonAmounts() {
  return useQuery({
    queryKey: queryKeys.people.amounts(),
    queryFn: ({ signal }) =>
      readAllAmounts((cursor) => api.company.amounts({ cursor }, { signal })),
  })
}

// Waits for the list but not the amounts: a failing proof service must not keep
// a dialog open (the mutation's own callbacks, which close it, run after this).
function refreshPeople(queryClient: QueryClient, amountsChanged = false) {
  if (amountsChanged) {
    void queryClient.invalidateQueries({ queryKey: queryKeys.people.amounts() })
  }
  return queryClient.invalidateQueries({ queryKey: queryKeys.people.list() })
}

// Side effects live in the mutation's own callbacks, not in the dialog that
// started it, so they still run if that dialog is gone.
export function useSavePerson() {
  const queryClient = useQueryClient()
  return useMutation<SavePersonResult, Error, SavePersonRequest>({
    mutationFn: async (request) =>
      savePerson(
        {
          repository: await peopleRepository(),
          setAmount: (personId, amount) =>
            api.company.setAmount(personId, amount),
        },
        request,
      ),
    onSuccess: (result, request) => {
      const { name } = request.input
      if (result.inviteStale) {
        toast.success("Changes saved", {
          description:
            "The email changed, so the invite already sent won't work. Send a new one.",
        })
      } else {
        toast.success(request.id ? "Changes saved" : `${name} added`)
      }
    },
    onError: (error, request) => {
      // A new person is on the list without an amount, and the dialog closes on
      // it. An edit keeps its dialog open, which says so itself.
      if (error instanceof AmountNotSavedError && request.id === undefined) {
        toast.warning(peopleMessageFor(error))
      }
    },
    // Settled, not success: a person saved without an amount is on the list now.
    onSettled: () => refreshPeople(queryClient, true),
  })
}

export function useRemovePerson() {
  const queryClient = useQueryClient()
  return useMutation<void, Error, PersonRecord>({
    mutationFn: async (person) => (await peopleRepository()).remove(person.id),
    onSuccess: (_, person) => toast.success(`${person.name} removed`),
    onSettled: () => refreshPeople(queryClient),
  })
}

// Sends the invite, or sends it again: the service issues a fresh link either way.
export function useSendInvite() {
  const queryClient = useQueryClient()
  const mutation = useMutation<unknown, Error, PersonRecord>({
    mutationFn: async (person) =>
      sendInvite(
        {
          repository: await peopleRepository(),
          invite: (personId) => api.company.invite(personId),
        },
        person.id,
      ),
    onSuccess: (_, person) => toast.success(`Invite sent to ${person.email}`),
    onError: (error, person) =>
      toast.error(inviteMessageFor(error), {
        action: isRetryablePeopleError(error)
          ? { label: "Try again", onClick: () => mutation.mutate(person) }
          : undefined,
      }),
    // A 409 means the list was out of date: show what the table says now.
    onSettled: () => refreshPeople(queryClient),
  })
  return mutation
}
