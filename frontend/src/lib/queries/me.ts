"use client"

import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query"
import { useState } from "react"
import { toast } from "sonner"
import { api } from "@/lib/api"
import type { SignStep } from "@/lib/api/sign"
import { saveBlob } from "@/lib/download"
import { useSignAndConfirm, useWallet } from "@/lib/wallet/context"
import {
  applyPendingMutation,
  exportPaymentsMutation,
  meQueries,
} from "./me-options"

const queries = meQueries(api)

export const useRecentPayments = () => useQuery(queries.recent())

export const usePaymentHistory = () => useInfiniteQuery(queries.history())

// `step` is where the signing flow is, for the button label.
export function useApplyPending() {
  const queryClient = useQueryClient()
  const wallet = useWallet()
  const run = useSignAndConfirm()
  const [step, setStep] = useState<SignStep | null>(null)
  const mutation = useMutation({
    ...applyPendingMutation({
      queryClient,
      accounts: api.accounts,
      wallet,
      run,
      onStep: setStep,
      onApplied: () => toast.success("Pending balance is now available"),
    }),
    onSettled: () => setStep(null),
  })
  return { ...mutation, step }
}

export function useExportPayments() {
  return useMutation(
    exportPaymentsMutation({
      exports: api.exports,
      save: saveBlob,
      notify: (message) => toast.success(message),
    }),
  )
}
