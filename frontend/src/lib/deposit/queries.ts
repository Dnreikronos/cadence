"use client"

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useState } from "react"
import { getDepositInfo, makePrivate } from "./mock"
import type { MakePrivateStep } from "./types"

const depositKey = ["deposit"] as const

export function useDepositInfo() {
  return useQuery({ queryKey: depositKey, queryFn: getDepositInfo })
}

export function useMakePrivate() {
  const queryClient = useQueryClient()
  const [step, setStep] = useState<MakePrivateStep | null>(null)
  const mutation = useMutation({
    mutationFn: (amount: number) => makePrivate(amount, setStep),
    onSuccess: (next) => queryClient.setQueryData(depositKey, next),
    onSettled: () => setStep(null),
  })
  return { ...mutation, step }
}
