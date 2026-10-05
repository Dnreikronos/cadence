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
import { apiConfig } from "@/lib/api/mode"
import {
  acquireFlowLock,
  flowLockName,
  type Lease,
  type OtherTab,
} from "@/lib/flow-lock"
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

export const runLockName = (viewer: Viewer) => flowLockName("payroll", viewer)

// The viewer's payments that may have been sent and are not settled, kept in this tab's
// storage so they survive a reload and signing out (see `evidence.ts`).
export function useSentPayments(viewer: Viewer): readonly SentPayment[] {
  const { payments } = runEvidenceFor(viewer)
  return useSyncExternalStore(payments.subscribe, payments.read, () => none)
}

// Whether saved payments could not be read and are set aside: until the person has
// released them, no run can be started.
export function useUnreadablePayments(viewer: Viewer) {
  const { payments } = runEvidenceFor(viewer)
  return useSyncExternalStore(
    payments.subscribe,
    payments.unreadable,
    () => false,
  )
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
  // Another tab is sending or checking a run for this account.
  const [otherTab, setOtherTab] = useState<OtherTab>(null)
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
          Date.now,
          apiConfig.mode,
        ),
      }
    },
    [sign, queryClient, held, evidence],
  )

  // One tab at a time, and one thing at a time within it. `lease` is the run lock when
  // the caller already holds it (a run is created under it, then signed); otherwise it is
  // taken here, and refused while another tab has it. It is released when the task ends.
  const exclusive = useCallback(
    async (
      runId: string,
      task: (context: RunContext) => Promise<void>,
      lease?: Lease,
    ) => {
      if (working.current) {
        lease?.release()
        return
      }
      working.current = true
      setBusy(true)
      let own = lease
      try {
        if (!own) {
          const got = await acquireFlowLock(runLockName(viewer))
          if (got.status === "busy") {
            setOtherTab("busy")
            return
          }
          setOtherTab(got.status === "maybe-busy" ? "maybe" : null)
          own = got.lease
        }
        await task(contextFor(runId, controller.current?.signal))
      } finally {
        own?.release()
        working.current = false
        setBusy(false)
      }
    },
    [contextFor, viewer],
  )

  // After a reload: ask about each payment the earlier page left with a signature, one
  // after another. Read once, on mount; a later render must not start it again.
  const latest = useRef(contextFor)
  useEffect(() => {
    latest.current = contextFor
  })
  // Once per mount: a pass that ran to its end is not repeated, one cut short by
  // leaving (or a development double mount) starts again from the saved list.
  const recovered = useRef(false)
  useEffect(() => {
    if (recovered.current) return
    const own = new AbortController()
    const saved = evidence.payments
      .read()
      .filter((payment) => payment.signature)
    let lease: Lease | undefined
    void (async () => {
      if (saved.length === 0) {
        recovered.current = true
        return
      }
      // The lock is held while the saved payments are asked about, and waited for while
      // another tab has it.
      for (let tries = 0; ; tries++) {
        const got = await acquireFlowLock(runLockName(viewer))
        if (own.signal.aborted) {
          if (got.status !== "busy") got.lease.release()
          return
        }
        if (got.status !== "busy") {
          lease = got.lease
          setOtherTab(got.status === "maybe-busy" ? "maybe" : null)
          break
        }
        setOtherTab("busy")
        await new Promise((resolve) =>
          setTimeout(resolve, tries < 3 ? 500 : 3_000),
        )
        if (own.signal.aborted) return
      }
      try {
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
        recovered.current = true
      } finally {
        lease?.release()
      }
    })()
    return () => {
      own.abort()
      lease?.release()
    }
  }, [evidence, viewer])

  return {
    wallet,
    local,
    busy,
    checking,
    otherTab,
    start: (created: RunCreated, lease?: Lease) => {
      held.holdAll(created.payments)
      return exclusive(
        created.run_id,
        (context) => paySequence(context, created.payments),
        lease,
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
