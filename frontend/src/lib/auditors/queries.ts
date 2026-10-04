"use client"

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { inviteAuditor, listAuditors, removeAuditor } from "./mock"

const auditorsKey = ["auditors"] as const

export function useAuditors() {
  return useQuery({ queryKey: auditorsKey, queryFn: listAuditors })
}

function useInvalidating<TVariables>(
  mutationFn: (variables: TVariables) => Promise<unknown>,
) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: auditorsKey }),
  })
}

export function useInviteAuditor() {
  return useInvalidating((email: string) => inviteAuditor(email))
}

export function useRemoveAuditor() {
  return useInvalidating((id: string) => removeAuditor(id))
}
