"use client"

import {
  useIsMutating,
  useMutation,
  useMutationState,
  useQueryClient,
} from "@tanstack/react-query"
import { useEffect, useMemo, useState, useSyncExternalStore } from "react"
import { toast } from "sonner"
import { api, currentUserId } from "@/lib/api"
import { apiConfig } from "@/lib/api/mode"
import {
  acquireFlowLock,
  flowLockName,
  type Lease,
  type OtherTab,
} from "@/lib/flow-lock"
import {
  failureOf,
  runWithdraw,
  type Held,
  type WithdrawInput,
} from "@/lib/withdraw/flow"
import { arrivalOf, checkState } from "@/lib/withdraw/check-state"
import {
  canRelease,
  checkHeldWithdrawals,
  heldOf,
  heldRecordsFor,
  releaseHeldChecked,
  releaseUnreadableChecked,
  withdrawEvidence,
  type HeldCheck,
  type HeldRecord,
} from "@/lib/withdraw/held"
import { prepareUnwrap } from "@/lib/withdraw/prepare"
import { useSignAndConfirm, useWallet } from "@/lib/wallet/context"
import { invalidateBalances } from "./invalidate"
import type { ViewerScope } from "./keys"

const withdrawKey = ["withdraw"] as const

export const withdrawalDoneToast =
  "Withdrawal complete. Withdrawals are public."

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

// The viewer's withdrawals that may have gone through: kept in the browser's storage per
// viewer, so they survive leaving the screen, a reload and another tab (signing out
// clears the query cache and removes these from the browser), and are never another
// person's. The reducer holds back these amounts; without them, coming back would show a
// fresh form for the same one.
export function useHeldRecords(viewer: ViewerScope): readonly HeldRecord[] {
  const list = heldRecordsFor(viewer)
  return useSyncExternalStore(list.subscribe, list.read, () => none)
}

export function useHeldWithdrawals(viewer: ViewerScope): readonly Held[] {
  const records = useHeldRecords(viewer)
  return useMemo(() => heldOf(records), [records])
}

export const withdrawLockName = (viewer: ViewerScope) =>
  flowLockName("withdraw", viewer)

const pause = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms)
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer)
        resolve()
      },
      { once: true },
    )
  })

// What the screen needs to say about looking up the withdrawals sent earlier.
export type WithdrawCheck = {
  // A lookup is under way or about to start: nothing new is sent meanwhile.
  checking: boolean
  // Another tab is sending or checking a withdrawal for this account.
  otherTab: OtherTab
  // What it settled since the last withdrawal started, to tell the person.
  settled: readonly HeldCheck[]
  // Amounts a lookup could not settle.
  unknownAmounts: ReadonlySet<string>
  checkAgain: () => void
  // Forget what was settled, once a new withdrawal starts.
  dismiss: () => void
}

// Finds out what became of withdrawals sent and not seen through, by confirming their
// saved signatures again, which prepares nothing. It looks at the ones found when the
// screen opens (after a reload, or signing back in), and at all of them when the person
// asks again (`checkState`). A withdrawal that ends in a sent failure on this very screen
// is not looked up by itself: the screen says to check, and "Check again" does. It holds
// the withdraw lock while it looks, and waits for it while another tab has it.
export function useWithdrawCheck(viewer: ViewerScope): WithdrawCheck {
  const queryClient = useQueryClient()
  const list = heldRecordsFor(viewer)
  const records = useHeldRecords(viewer)
  const running = useWithdrawInFlight()
  // What was held on arrival.
  const [arrival] = useState(() => arrivalOf(list.read()))
  // Bumped to look again.
  const [tick, setTick] = useState(0)
  // The lookup that last ended: for which saved signatures, and which `checkAgain`.
  const [checked, setChecked] = useState<{ key: string; tick: number }>()
  const [settled, setSettled] = useState<readonly HeldCheck[]>([])
  const [unknownAmounts, setUnknown] = useState<ReadonlySet<string>>(new Set())
  const [otherTab, setOtherTab] = useState<OtherTab>(null)
  // Read each render, so the form is disabled before the effect has run.
  const { include, checking } = checkState({
    records,
    arrival,
    tick,
    checked,
    running,
  })

  useEffect(() => {
    if (!checking) {
      // Nothing left to look up (another tab settled it): nothing to wait for either.
      setOtherTab(null)
      return
    }
    const controller = new AbortController()
    const { signal } = controller
    let lease: Lease | undefined
    void (async () => {
      // Wait for the flow while another tab has it.
      for (let tries = 0; ; tries++) {
        const got = await acquireFlowLock(withdrawLockName(viewer))
        if (signal.aborted) {
          if (got.status !== "busy") got.lease.release()
          return
        }
        if (got.status !== "busy") {
          lease = got.lease
          setOtherTab(got.status === "maybe-busy" ? "maybe" : null)
          break
        }
        setOtherTab("busy")
        await pause(tries < 3 ? 500 : 3_000, signal)
        if (signal.aborted) return
      }
      try {
        const checks = await checkHeldWithdrawals({
          records: list,
          api,
          refresh: () => void invalidateBalances(queryClient),
          include,
          signal,
        })
        if (signal.aborted) return
        setSettled((earlier) => [
          ...earlier,
          ...checks.filter((check) => check.outcome !== "unknown"),
        ])
        setUnknown((earlier) => {
          const next = new Set(earlier)
          for (const check of checks) {
            if (check.outcome === "unknown") next.add(check.amount)
            else next.delete(check.amount)
          }
          return next
        })
        // Keyed by what is left, so the records it settled do not start another lookup.
        setChecked({
          key: checkState({ records: list.read(), arrival, tick, running }).key,
          tick,
        })
      } catch {
        // Aborted by leaving. Anything else was already turned into "unknown".
      } finally {
        lease?.release()
      }
    })()
    return () => {
      controller.abort()
      lease?.release()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [list, checking, tick, queryClient])

  return {
    checking,
    otherTab,
    settled,
    unknownAmounts,
    checkAgain: () => {
      setSettled([])
      setTick((value) => value + 1)
    },
    dismiss: () => setSettled([]),
  }
}

// Whether saved withdrawals could not be read and are set aside: until the person has
// released them, nothing can be withdrawn.
export function useUnreadableWithdrawals(viewer: ViewerScope) {
  const list = heldRecordsFor(viewer)
  return useSyncExternalStore(list.subscribe, list.unreadable, () => false)
}

// The deliberate release of a hold: offered once a withdrawal has been unresolved for
// two minutes and a lookup, if one can be made, could not settle it.
export function useWithdrawRelease(viewer: ViewerScope, check: WithdrawCheck) {
  const list = heldRecordsFor(viewer)
  const records = useHeldRecords(viewer)
  const unreadable = useUnreadableWithdrawals(viewer)
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 15_000)
    return () => clearInterval(timer)
  }, [])
  return {
    canRelease: (amount: string) => {
      const record = records.find((r) => r.amount_units === amount)
      return (
        !!record &&
        !check.checking &&
        canRelease(record, { now, lookedUp: check.unknownAmounts.has(amount) })
      )
    },
    // On the record this screen showed: refused if it has changed since.
    release: (amount: string) => {
      const seen = records.find((record) => record.amount_units === amount)
      return seen
        ? releaseHeldChecked({
            records: list,
            seen,
            lock: () => acquireFlowLock(withdrawLockName(viewer)),
          })
        : Promise.resolve("changed" as const)
    },
    unreadable,
    releaseUnreadable: () =>
      releaseUnreadableChecked(list, () =>
        acquireFlowLock(withdrawLockName(viewer)),
      ),
  }
}

export type WithdrawVariables = Omit<WithdrawInput, "wallet"> & {
  // The withdraw lock, held for as long as the withdrawal runs.
  lease?: Lease
}

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
          prepare: (ask) =>
            prepareUnwrap(wallet.signer, ask, {
              prepare: (request) => api.unwrap.prepare(request),
              userId: currentUserId,
            }),
          signAndConfirm: (prepared, confirm, onStep, extra) =>
            signAndConfirm(prepared, confirm, onStep, extra),
          confirm: (request) => api.unwrap.confirm(request),
        },
        {
          ...variables,
          wallet: wallet.address,
          ...withdrawEvidence(
            records,
            variables.amount,
            Date.now,
            apiConfig.mode,
          ),
        },
      ),
    onSettled: (_data, _error, variables) => variables.lease?.release(),
    // `void`: the library waits for what these return before it reports the result,
    // and the money has already moved, so the screen must not wait on a refetch.
    onSuccess: (outcome) => {
      if (outcome.kind !== "done") return
      // No amount in a toast: it stays on the page, where a screen reader reads it too.
      toast.success(withdrawalDoneToast)
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
