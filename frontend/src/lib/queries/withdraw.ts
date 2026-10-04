"use client"

import {
  useIsMutating,
  useMutation,
  useMutationState,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query"
import { toast } from "sonner"
import { api } from "@/lib/api"
import { formatUnits } from "@/lib/money"
import {
  failureOf,
  heldBy,
  mergeHeld,
  runWithdraw,
  type Held,
  type WithdrawInput,
} from "@/lib/withdraw/flow"
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

const withdrawKey = ["withdraw"] as const

// True while a withdrawal is running anywhere in the app. The mutation outlives the
// screen that started it, so a screen opened mid-run must not start a second one.
export function useWithdrawInFlight() {
  return useIsMutating({ mutationKey: withdrawKey }) > 0
}

// Every withdrawal of this session that may have gone through, read from the
// mutation cache so it survives leaving the screen. The reducer holds those amounts
// back; without this, coming back would show a fresh form for the same amount.
export function useSentWithdrawal(): readonly Held[] {
  const sent = useMutationState({
    filters: { mutationKey: withdrawKey, status: "error" },
    select: (mutation): Held | null =>
      heldBy(
        mutation.state.error,
        (mutation.state.variables as WithdrawVariables | undefined)?.amount,
      ),
  })
  return mergeHeld(
    [],
    sent.filter((held) => held !== null),
  )
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
    mutationKey: withdrawKey,
    // Never run prepare and sign again by itself, whatever the app's mutation default.
    retry: false,
    // Kept for the session: a failed one is what `useSentWithdrawal` reads.
    gcTime: Infinity,
    mutationFn: (variables: WithdrawVariables) =>
      runWithdraw(
        {
          prepare: (request) => api.unwrap.prepare(request),
          signAndConfirm: (prepared, confirm, onStep, onSubmitted) =>
            signAndConfirm(prepared, confirm, onStep, { onSubmitted }),
          confirm: (request) => api.unwrap.confirm(request),
        },
        { ...variables, wallet: wallet.address },
      ),
    // `void`: the library waits for what these return before it reports the result,
    // and the money has already moved, so the screen must not wait on a refetch.
    onSuccess: (outcome, variables) => {
      if (outcome.kind !== "done") return
      toast.success(
        `Withdrew ${formatUnits(variables.amount)}. Withdrawals are public.`,
      )
      void invalidateBalances(queryClient)
    },
    onError: (error) => {
      const failure = failureOf(error)
      // A balance that changed under the person, or a withdrawal that may have gone
      // through, is worth a fresh read.
      if (failure.refreshBalance) void invalidateBalances(queryClient)
      // A failure the person cannot just retry must not be silent if the screen is gone.
      if (!failure.retryable) toast.error(failure.message)
    },
  })
}
