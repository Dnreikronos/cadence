"use client"

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useState } from "react"
import { invalidateBalances } from "@/lib/queries/invalidate"
import { queryKeys } from "@/lib/queries/keys"
import { getDepositInfo, makePrivate } from "./mock"
import type { MakePrivateStep } from "./types"

export function useDepositInfo() {
  return useQuery({
    queryKey: queryKeys.deposit.info(),
    queryFn: getDepositInfo,
  })
}

export function useMakePrivate() {
  const queryClient = useQueryClient()
  const [step, setStep] = useState<MakePrivateStep | null>(null)
  const mutation = useMutation({
    // Integer base-unit string, the shape the `POST /wrap` body will take.
    mutationFn: (amount: string) => makePrivate(amount, setStep),
    onSuccess: (next) => {
      queryClient.setQueryData(queryKeys.deposit.info(), next)
      // Moving USDC into the private balance changes what the sidebar shows.
      return invalidateBalances(queryClient)
    },
    onSettled: () => setStep(null),
  })
  return { ...mutation, step }
}
