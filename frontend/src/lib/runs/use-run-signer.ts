"use client"

import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  useSyncExternalStore,
} from "react"
import { useQueryClient } from "@tanstack/react-query"
import { api } from "@/lib/api"
import type { RunCreated } from "@/lib/api/schemas"
import { invalidateBalances } from "@/lib/queries/invalidate"
import { queryKeys } from "@/lib/queries/keys"
import { useSignAndConfirm, useWallet } from "@/lib/wallet/context"
import {
  recordEvidence,
  runEvidenceFor,
  unsettledPeople,
  type SentPayment,
  type Viewer,
} from "./evidence"
import {
  paySequence,
  recheckOne,
  retryOne,
  type RunApi,
  type RunContext,
} from "./executor"
import { createHeldStore } from "./held"
import { holdingRetries, runEvents, signAgain } from "./sign-again"
import { localReducer } from "./progress"
import { hydrateLocal, recoverOne } from "./recover"

const runApi: RunApi = {
  confirmPayment: (runId, paymentId, signature) =>
    api.runs.confirmPayment(runId, paymentId, signature),
  retryPayment: (runId, paymentId) => api.runs.retryPayment(runId, paymentId),
}

const none: readonly SentPayment[] = []

// The viewer's payments that may have been sent and are not settled, kept in this tab's
// storage so they survive a reload and signing out (see `evidence.ts`).
export function useSentPayments(viewer: Viewer): readonly SentPayment[] {
  const { payments } = runEvidenceFor(viewer)
  return useSyncExternalStore(payments.subscribe, payments.read, () => none)
}

// Who has a payment that may have been sent and is not settled: not payable until it is.
export function useUnsettledPeople(viewer: Viewer): ReadonlySet<string> {
  const payments = useSentPayments(viewer)
  return useMemo(() => unsettledPeople(payments), [payments])
}

// Signs payroll payments with the user's wallet, one at a time, and keeps what this
// browser is doing to each one. Leaving the page stops it: the unsigned payments stay as
// they were. Only one thing is signed at a time, so a call while busy is ignored.
//
// A payment that reaches the submit step is kept for the viewer (`evidence.ts`) until its
// outcome is final. On mount, the ones kept by an earlier page are asked about again with
// their saved signature and shown as checking meanwhile; nothing is ever signed again
// for them.
export function useRunSigner(viewer: Viewer) {
  const wallet = useWallet()
  const sign = useSignAndConfirm()
  const queryClient = useQueryClient()
  const evidence = runEvidenceFor(viewer)
  const [local, dispatch] = useReducer(
    localReducer,
    evidence.payments.read(),
    hydrateLocal,
  )
  // Saved payments being asked about after a reload.
  const [checking, setChecking] = useState<ReadonlySet<string>>(
    () =>
      new Set(
        evidence.payments
          .read()
          .filter((payment) => payment.signature)
          .map((payment) => payment.payment_id),
      ),
  )
  const [busy, setBusy] = useState(false)
  // Cancelled signatures: the prepared transactions, kept in memory so the same one is
  // signed again (see `held.ts`). Not state: a change to it always comes with a dispatch.
  const [held] = useState(createHeldStore)
  const working = useRef(false)
  const controller = useRef<AbortController | null>(null)

  useEffect(() => {
    const own = new AbortController()
    controller.current = own
    return () => own.abort()
  }, [])

  const contextFor = useCallback(
    (runId: string, signal?: AbortSignal): RunContext => {
      const refreshRun = () =>
        queryClient.invalidateQueries({
          queryKey: queryKeys.runs.detail(runId),
        })
      return {
        runId,
        sign,
        api: holdingRetries(runApi, held),
        signal,
        // What the screen shows and which transactions stay held to sign again
        // (`runEvents`), with the records of what may have been sent kept alongside
        // (`recordEvidence`).
        events: recordEvidence(
          runEvents(held, dispatch, {
            // Money moved: the sidebar balance and the payment lists are stale.
            confirmed: () => {
              void invalidateBalances(queryClient)
              void queryClient.invalidateQueries({
                queryKey: queryKeys.payments.all,
              })
              void refreshRun()
            },
            failed: () => void refreshRun(),
          }),
          evidence,
          runId,
        ),
      }
    },
    [sign, queryClient, held, evidence],
  )

  const exclusive = useCallback(
    async (runId: string, task: (context: RunContext) => Promise<void>) => {
      if (working.current) return
      working.current = true
      setBusy(true)
      try {
        await task(contextFor(runId, controller.current?.signal))
      } finally {
        working.current = false
        setBusy(false)
      }
    },
    [contextFor],
  )

  // After a reload: ask about each payment the earlier page left with a signature, one
  // after another. Read once, on mount; a later render must not start it again.
  const latest = useRef(contextFor)
  useEffect(() => {
    latest.current = contextFor
  })
  useEffect(() => {
    const own = new AbortController()
    const saved = evidence.payments
      .read()
      .filter((payment) => payment.signature)
    void (async () => {
      for (const record of saved) {
        if (own.signal.aborted) return
        await recoverOne(latest.current(record.run_id, own.signal), record)
        if (own.signal.aborted) return
        setChecking((current) => {
          const next = new Set(current)
          next.delete(record.payment_id)
          return next
        })
      }
    })()
    return () => own.abort()
  }, [evidence])

  return {
    wallet,
    local,
    busy,
    checking,
    start: (created: RunCreated) => {
      held.holdAll(created.payments)
      return exclusive(created.run_id, (context) =>
        paySequence(context, created.payments),
      )
    },
    // Whether this page still holds the transaction of a cancelled signature.
    canSignAgain: (paymentId: string) => held.has(paymentId),
    // Signs the held transaction again, without preparing a new one. Past its blockhash
    // it is dropped and the payment is shown as failed, so the normal retry applies.
    signAgain: (runId: string, paymentId: string) =>
      exclusive(runId, (context) =>
        signAgain(context, held, dispatch, paymentId),
      ),
    retry: (runId: string, paymentId: string) =>
      exclusive(runId, (context) => retryOne(context, paymentId)),
    recheck: (runId: string, paymentId: string, signature: string) =>
      exclusive(runId, (context) => recheckOne(context, paymentId, signature)),
  }
}

export type RunSigner = ReturnType<typeof useRunSigner>
