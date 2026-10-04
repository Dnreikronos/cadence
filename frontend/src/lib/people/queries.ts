"use client"

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import {
  createPerson,
  listPeople,
  removePerson,
  sendInvite,
  updatePerson,
} from "./mock"
import { queryKeys } from "@/lib/queries/keys"
import type { PersonInput } from "./types"

export function usePeople() {
  return useQuery({ queryKey: queryKeys.people.list(), queryFn: listPeople })
}

function useInvalidating<TVariables>(
  mutationFn: (variables: TVariables) => Promise<unknown>,
) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn,
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: queryKeys.people.all }),
  })
}

export function useSavePerson() {
  return useInvalidating(
    ({ id, input }: { id?: string; input: PersonInput }) =>
      id ? updatePerson(id, input) : createPerson(input),
  )
}

export function useRemovePerson() {
  return useInvalidating((id: string) => removePerson(id))
}

export function useSendInvite() {
  return useInvalidating((id: string) => sendInvite(id))
}
