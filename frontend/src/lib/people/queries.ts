"use client"

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import {
  createPerson,
  listPeople,
  removePerson,
  sendInvite,
  updatePerson,
} from "./mock"
import type { PersonInput } from "./types"

const peopleKey = ["people"] as const

export function usePeople() {
  return useQuery({ queryKey: peopleKey, queryFn: listPeople })
}

function useInvalidating<TVariables>(
  mutationFn: (variables: TVariables) => Promise<unknown>,
) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: peopleKey }),
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
