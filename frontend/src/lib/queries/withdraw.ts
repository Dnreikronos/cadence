"use client"

import {
  useIsMutating,
  useMutation,
  useMutationState,
  useQueryClient,
} from "@tanstack/react-query"
import { useEffect, useMemo, useState, useSyncExternalStore } from "react"
import { toast } from "sonner"
import { api } from "@/lib/api"
import { formatUnits } from "@/lib/money"
import {
  failureOf,
  runWithdraw,
  type Held,
  type WithdrawInput,
} from "@/lib/withdraw/flow"
import {
  checkableKey,
  checkHeldWithdrawals,
  heldOf,
  heldRecordsFor,
  withdrawEvidence,
  type HeldCheck,
  type HeldRecord,
} from "@/lib/withdraw/held"
import { useSignAndConfirm, useWallet } from "@/lib/wallet/context"
import { invalidateBalances } from "./invalidate"
import type { ViewerScope } from "./keys"

const withdrawKey = ["withdraw"] as const

// True while a withdrawal is running anywhere in the app. The mutation outlives the
// screen that started it, so a screen opened mid-run must not start a second one.
export function useWithdrawInFlight() {
  return useIsMutating({ mutationKey: withdrawKey }) > 0
}

// The amounts of withdrawals running now. From the moment one is handed to the network
// it is kept as held (so a reload cannot forget it), but while it runs it is not yet
// something that "may have gone through": the screen leaves it out of its notices.
export function useWithdrawingAmounts(): readonly string[] {
  const amounts = useMutationState({
    filters: { mutationKey: withdrawKey, status: "pending" },
    select: (mutation) =>
      (mutation.state.variables as WithdrawVariables | undefined)?.amount,
  })
  return amounts.filter((amount) => amount !== undefined)
}

const none: readonly HeldRecord[] = []

// The viewer's withdrawals that may have gone through: kept in this tab's storage per
// viewer, so they survive leaving the screen, a reload and signing out (which clears
// the query cache but not these), and are never another person's. The reducer holds
// back these amounts; without them, coming back would show a fresh form for the same one.
export function useHeldRecords(viewer: ViewerScope): readonly HeldRecord[] {
  const list = heldRecordsFor(viewer)
  return useSyncExternalStore(list.subscribe, list.read, () => none)
}

export function useHeldWithdrawals(viewer: ViewerScope): readonly Held[] {
  const records = useHeldRecords(viewer)
  return useMemo(() => heldOf(records), [records])
}

// What the screen needs to say about looking up the withdrawals sent earlier.
export type WithdrawCheck = {
  // A lookup is under way or about to start: nothing new is sent meanwhile.
  checking: boolean
  // What it settled since the last withdrawal started, to tell the person.
  settled: readonly HeldCheck[]
  checkAgain: () => void
  // Forget what was settled, once a new withdrawal starts.
  dismiss: () => void
}

// Finds out what became of withdrawals sent and not seen through, by confirming their
// saved signatures again, which prepares nothing. It runs on mount (after a reload, or
// signing back in) and again after a withdrawal here ends in a sent failure.
export function useWithdrawCheck(viewer: ViewerScope): WithdrawCheck {
  const queryClient = useQueryClient()
  const list = heldRecordsFor(viewer)
  const records = useHeldRecords(viewer)
  const running = useWithdrawInFlight()
  const key = checkableKey(records)
  // Bumped to look again.
  const [tick, setTick] = useState(0)
  // The lookup that last ended: for which saved signatures, and which `checkAgain`.
  const [checked, setChecked] = useState<{ key: string; tick: number }>()
  const [settled, setSettled] = useState<readonly HeldCheck[]>([])

  useEffect(() => {
    if (running || key === "") return
    const controller = new AbortController()
    checkHeldWithdrawals({
      records: list,
      api,
      refresh: () => void invalidateBalances(queryClient),
      signal: controller.signal,
    }).then(
      (checks) => {
        if (controller.signal.aborted) return
        setSettled((earlier) => [
          ...earlier,
          ...checks.filter((check) => check.outcome !== "unknown"),
        ])
        // Keyed by what is left, so the records it settled do not start another lookup.
        setChecked({ key: checkableKey(list.read()), tick })
      },
      () => {
        // Aborted by leaving. Anything else was already turned into "unknown".
      },
    )
    return () => controller.abort()
  }, [list, key, running, tick, queryClient])

  // Read each render, so the form is disabled before the effect has run.
  const checking =
    !running && key !== "" && !(checked?.key === key && checked.tick === tick)

  return {
    checking,
    settled,
    checkAgain: () => {
      setSettled([])
      setTick((value) => value + 1)
    },
    dismiss: () => setSettled([]),
  }
}

export type WithdrawVariables = Omit<WithdrawInput, "wallet">

// Prepare, sign and confirm a withdrawal. The side effects live in the mutation's
// own callbacks, not the screen's: leaving the page mid-withdrawal must not lose the
// result or leave the sidebar balance stale. From the moment it is handed to the
// network, a record of it is kept for this viewer until the outcome is final.
export function useWithdraw(viewer: ViewerScope) {
  const queryClient = useQueryClient()
  const wallet = useWallet()
  const signAndConfirm = useSignAndConfirm()
  const records = heldRecordsFor(viewer)

  return useMutation({
    mutationKey: withdrawKey,
    // Never run prepare and sign again by itself, whatever the app's mutation default.
    retry: false,
    mutationFn: (variables: WithdrawVariables) =>
      runWithdraw(
        {
          prepare: (request) => api.unwrap.prepare(request),
          signAndConfirm: (prepared, confirm, onStep, onSubmitted) =>
            signAndConfirm(prepared, confirm, onStep, { onSubmitted }),
          confirm: (request) => api.unwrap.confirm(request),
        },
        {
          ...variables,
          wallet: wallet.address,
          ...withdrawEvidence(records, variables.amount),
        },
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
