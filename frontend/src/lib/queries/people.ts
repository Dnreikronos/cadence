"use client"

import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query"
import { toast } from "sonner"
import { api } from "@/lib/api"
import type { PersonAmount } from "@/lib/api/schemas"
import {
  readAllAmounts,
  withAmount,
  type AmountsRead,
} from "@/lib/people/amounts"
import { PeopleNotConfiguredError } from "@/lib/people/errors"
import { peopleRepository, type PeopleList } from "@/lib/people/repository"
import {
  savePerson,
  sendInvite,
  type SavePersonRequest,
  type SavePersonResult,
} from "@/lib/people/service"
import { clearInviteStale, markInviteStale } from "@/lib/people/stale-invites"
import {
  inviteFailureCopy,
  saveSuccessCopy,
  saveWarningCopy,
} from "@/lib/people/toasts"
import type { PersonRecord } from "@/lib/people/types"
import { shouldRetry } from "./client"
import { queryKeys } from "./keys"

// The people table: names, emails, kinds and who has an account.
export function usePeople() {
  return useQuery<PeopleList>({
    queryKey: queryKeys.people.list(),
    queryFn: async () => (await peopleRepository()).list(),
    // Missing configuration answers the same way again.
    retry: (count, error) =>
      !(error instanceof PeopleNotConfiguredError) && shouldRetry(count, error),
  })
}

const AMOUNTS_PAGE = 100

// What each person is paid, from the proof service. A separate query, so the
// people stay on screen when only the amounts fail.
export function usePersonAmounts() {
  return useQuery<AmountsRead>({
    queryKey: queryKeys.people.amounts(),
    queryFn: ({ signal }) =>
      readAllAmounts((cursor) =>
        api.company.amounts({ cursor, limit: AMOUNTS_PAGE }, { signal }),
      ),
  })
}

// The amount just written is the newest figure there is: put it in the cache
// now, so the screen (and the form's "did it change?") does not wait for a
// refetch that may fail. A query that is in error holds figures of unknown age,
// which one fresh value does not make fresh: it is left to its retry.
export function recordSavedAmount(
  queryClient: QueryClient,
  saved: Pick<PersonAmount, "person_id" | "amount">,
) {
  const key = queryKeys.people.amounts()
  if (queryClient.getQueryState(key)?.status !== "success") return
  queryClient.setQueryData<AmountsRead>(key, (read) =>
    withAmount(read, saved.person_id, saved.amount),
  )
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
          setAmount: async (personId, amount) => {
            const saved = await api.company.setAmount(personId, amount)
            recordSavedAmount(queryClient, saved)
            return saved
          },
        },
        request,
      ),
    onSuccess: (result, request) => {
      if (result.inviteStale) markInviteStale(result.id)
      const { message, description } = saveSuccessCopy(result, request)
      toast.success(message, { description })
    },
    onError: (error, request) => {
      const warning = saveWarningCopy(error, request)
      if (warning) toast.warning(warning)
    },
    // Settled, not success: a person saved without an amount is on the list now.
    onSettled: () => refreshPeople(queryClient, true),
  })
}

export function useRemovePerson() {
  const queryClient = useQueryClient()
  return useMutation<void, Error, PersonRecord>({
    mutationFn: async (person) => (await peopleRepository()).remove(person.id),
    onSuccess: (_, person) => {
      clearInviteStale(person.id)
      toast.success(`${person.name} removed`)
    },
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
    onSuccess: (_, person) => {
      clearInviteStale(person.id)
      toast.success(`Invite sent to ${person.email}`)
    },
    onError: (error, person) => {
      const { message, retry } = inviteFailureCopy(error)
      toast.error(message, {
        action: retry
          ? { label: "Try again", onClick: () => mutation.mutate(person) }
          : undefined,
      })
    },
    // A 409 means the list was out of date: show what the table says now.
    onSettled: () => refreshPeople(queryClient),
  })
  return mutation
}
