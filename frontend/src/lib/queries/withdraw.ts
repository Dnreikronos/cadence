"use client"

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"
import { api } from "@/lib/api"
import { formatUnits } from "@/lib/money"
import { failureOf, runWithdraw, type WithdrawInput } from "@/lib/withdraw/flow"
import { useSignAndConfirm, useWallet } from "@/lib/wallet/context"
import { invalidateBalances } from "./invalidate"
import { queryKeys, type ViewerScope } from "./keys"

// The signed-in recipient's own balance. Shares its key with the sidebar, so one
// answer serves both.
export function useMyBalance(viewer: ViewerScope) {
  return useQuery({
    queryKey: queryKeys.balance.me(viewer),
    queryFn: ({ signal }) => api.me.balance({ signal }),
  })
}

export type WithdrawVariables = Omit<WithdrawInput, "wallet">

// Prepare, sign and confirm a withdrawal. The side effects live in the mutation's
// own callbacks, not the screen's: leaving the page mid-withdrawal must not lose the
// result or leave the sidebar balance stale.
export function useWithdraw() {
  const queryClient = useQueryClient()
  const wallet = useWallet()
  const signAndConfirm = useSignAndConfirm()

  return useMutation({
    mutationFn: (variables: WithdrawVariables) =>
      runWithdraw(
        {
          prepare: (request) => api.unwrap.prepare(request),
          signAndConfirm,
          confirm: (request) => api.unwrap.confirm(request),
        },
        { ...variables, wallet: wallet.address },
      ),
    onSuccess: (outcome, variables) => {
      if (outcome.kind !== "done") return
      toast.success(
        `Withdrew ${formatUnits(variables.amount)}. Withdrawals are public.`,
      )
      return invalidateBalances(queryClient)
    },
    // A balance that changed under the person, or a withdrawal still unconfirmed,
    // is worth a fresh read.
    onError: (error) => {
      if (failureOf(error).refreshBalance)
        return invalidateBalances(queryClient)
    },
  })
}
