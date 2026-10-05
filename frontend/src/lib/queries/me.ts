"use client"

import {
  useInfiniteQuery,
  useIsMutating,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query"
import { useEffect, useRef, useState } from "react"
import { toast } from "sonner"
import { api } from "@/lib/api"
import { saveBlob } from "@/lib/download"
import { applyUi, type Lock } from "@/lib/me/apply-ui"
import {
  APPLY_KIND,
  sentMessage,
  type ApplyPhase,
  type ApplyStore,
} from "@/lib/me/apply-pending"
import {
  checkLastApply,
  sentApply,
  type LastApply,
  type LastApplyStore,
} from "@/lib/me/last-apply"
import {
  SETTLE_TIMEOUT_MS,
  settleState,
  startSettleReads,
  type BalanceRead,
  type Confirmed,
} from "@/lib/me/settle"
import {
  clearSubmission,
  readSubmission,
  recordSubmission,
} from "@/lib/submissions"
import { useSignAndConfirm, useWallet } from "@/lib/wallet/context"
import { invalidateBalances } from "./invalidate"
import { queryKeys } from "./keys"
import {
  applyKey,
  applyPendingMutation,
  exportPaymentsMutation,
  meQueries,
} from "./me-options"

const queries = meQueries(api)

export const useRecentPayments = () => useQuery(queries.recent())

export const usePaymentHistory = () => useInfiniteQuery(queries.history())

// Where the apply in flight is kept, so a reload can find out what became of it.
const applyStore: ApplyStore & LastApplyStore = {
  read: () => readSubmission(APPLY_KIND),
  record: (record) => recordSubmission(record),
  clear: () => clearSubmission(APPLY_KIND),
}

// Balances and the setup state, after something that may have changed them.
function refreshAccount(queryClient: ReturnType<typeof useQueryClient>) {
  return Promise.all([
    invalidateBalances(queryClient),
    queryClient.invalidateQueries({ queryKey: queryKeys.status.all }),
  ])
}

// Applying pending credits, with everything around it that keeps it from being sent
// twice: one at a time, a lock while an apply sent earlier is looked up (also after a
// reload), no retry after a failure that may have gone through, and no second apply
// while the balance catches up with a confirmed one.
export function useApplyPending(balance: BalanceRead | undefined) {
  const queryClient = useQueryClient()
  const wallet = useWallet()
  const run = useSignAndConfirm()
  const [phase, setPhase] = useState<ApplyPhase | null>(null)
  const [lock, setLock] = useState<Lock>("none")
  const [last, setLast] = useState<LastApply>("none")
  // Bumped to look up the last apply again.
  const [tick, setTick] = useState(0)
  const [now, setNow] = useState(() => Date.now())
  // An apply found confirmed by the lookup, which has no receipt of its own.
  const [recovered, setRecovered] = useState<Confirmed>()
  const latest = useRef(balance)
  useEffect(() => {
    latest.current = balance
  })
  const running = useIsMutating({ mutationKey: applyKey }) > 0

  const mutation = useMutation({
    ...applyPendingMutation({
      queryClient,
      accounts: api.accounts,
      wallet,
      run,
      store: applyStore,
      onPhase: setPhase,
      onApplied: () => toast.success("Pending balance is now available"),
      onSent: () => toast.error(sentMessage),
    }),
    onSettled: () => setPhase(null),
  })
  const { reset, variables } = mutation

  // An apply sent and not seen through is looked up by confirming it again, which
  // prepares nothing. It runs on mount (after a reload) and after a sent failure.
  useEffect(() => {
    if (wallet.status !== "ready" || running) return
    if (!sentApply(applyStore, wallet.address)) return
    const controller = new AbortController()
    // What was pending when Apply was pressed, if this screen pressed it.
    const pressed = variables?.pendingBefore
    setLock("checking")
    checkLastApply({
      store: applyStore,
      wallet: wallet.address,
      accounts: api.accounts,
      refresh: () => void refreshAccount(queryClient),
      signal: controller.signal,
    }).then(
      (outcome) => {
        if (controller.signal.aborted) return
        setLock("none")
        setLast(outcome)
        // The read can lag behind it, as after an apply confirmed here.
        const seen = latest.current
        if (outcome === "confirmed" && seen && seen.pending !== "0") {
          setRecovered({
            pendingBefore: pressed ?? seen.pending,
            slot: seen.as_of_slot,
            at: Date.now(),
          })
        }
        // The failure it explained is settled: no stale "check" prompt.
        reset()
      },
      () => {
        // The service could not be asked: the lock stays until it can be.
        if (!controller.signal.aborted) setLock("check-failed")
      },
    )
    return () => controller.abort()
  }, [
    wallet.status,
    wallet.address,
    running,
    tick,
    queryClient,
    reset,
    variables,
  ])

  const confirmed = mutation.data?.confirmed ?? recovered
  const settle = settleState(confirmed, balance, now)
  // What the read loop asks before each read, without restarting it on every change.
  const latestSettle = useRef(settle)
  useEffect(() => {
    latestSettle.current = settle
  })
  useEffect(() => {
    if (settle !== "waiting" || !confirmed) return
    // Bounded backoff (see `startSettleReads`): it stops by itself once `settle` is no
    // longer "waiting", and when the effect is cleaned up.
    const stopReads = startSettleReads({
      waiting: () => latestSettle.current === "waiting",
      read: () => {
        setNow(Date.now())
        void invalidateBalances(queryClient)
      },
    })
    const giveUp = setTimeout(
      () => setNow(Date.now()),
      Math.max(0, confirmed.at + SETTLE_TIMEOUT_MS - Date.now()) + 50,
    )
    return () => {
      stopReads()
      clearTimeout(giveUp)
    }
  }, [settle, confirmed, queryClient])

  // Read each render, so the lock is there before the check effect has run.
  const recorded =
    wallet.status === "ready" && !!sentApply(applyStore, wallet.address)
  const effectiveLock: Lock =
    lock !== "none" ? lock : !running && recorded ? "checking" : "none"

  // Closing the tab after the transaction went out would leave the person unsure.
  const guarded =
    (running && (phase === "submitting" || phase === "confirming")) ||
    effectiveLock === "checking"
  useEffect(() => {
    if (!guarded) return
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault()
      event.returnValue = ""
    }
    window.addEventListener("beforeunload", warn)
    return () => window.removeEventListener("beforeunload", warn)
  }, [guarded])

  const ui = applyUi({
    pending: balance?.pending ?? "0",
    running,
    phase,
    lock: effectiveLock,
    settle,
    outcome: last,
    error: running ? null : mutation.error,
    wallet: { ready: wallet.status === "ready", loading: wallet.loading },
  })

  return {
    ui,
    lock: effectiveLock,
    settle,
    last,
    error: running ? null : mutation.error,
    succeeded: mutation.isSuccess,
    walletReady: wallet.status === "ready",
    walletLoading: wallet.loading,
    apply: () => {
      if (!balance || !ui.canApply) return
      setLast("none")
      setRecovered(undefined)
      mutation.mutate({ pendingBefore: balance.pending })
    },
    // Reads the balance and the setup state again; nothing is sent.
    checkBalance: () => refreshAccount(queryClient),
    // Confirms the last apply again; nothing is prepared.
    checkAgain: () => {
      setLock("none")
      setTick((value) => value + 1)
    },
  }
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
