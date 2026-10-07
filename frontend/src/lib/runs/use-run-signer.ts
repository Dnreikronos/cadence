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
import type { Run } from "@/lib/api/schemas"
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
  approvedPayees,
  checkedSign,
  paymentKey,
  recheckOne,
  retryablePositions,
  retryRun,
  signablesOf,
  type Payees,
  type RunApi,
  type RunContext,
} from "./executor"
import { createHeldStore } from "./held"
import { deriveBalanceKey, senderAccountFor } from "./keys"
import { continueRun, runEvents } from "./sign-again"
import { localReducer } from "./progress"
import { hydrateLocal, recoverOne } from "./recover"

const runApi: RunApi = {
  confirm: (runId, item) => api.runs.confirm(runId, { payments: [item] }),
  retry: (runId, request) => api.runs.retry(runId, request),
}

// Who a position of a run pays: a person id, or the account when no one is known.
export type PersonOf = (position: number) => string

// For a task that never signs (asking about a payment already sent).
const nobody: Payees = new Map()

const none: readonly SentPayment[] = []

export const runLockName = (viewer: Viewer) => flowLockName("payroll", viewer)

// The viewer's payments that may have been sent and are not settled, kept in the browser's
// storage so they survive a reload and are seen by every tab (see `evidence.ts`).
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
          .map((payment) => paymentKey(payment.run_id, payment.position)),
      ),
  )
  const [busy, setBusy] = useState(false)
  // Another tab is sending or checking a run for this account.
  const [otherTab, setOtherTab] = useState<OtherTab>(null)
  // Cancelled signatures: the prepared transactions, kept in memory so the same one is
  // signed again (see `held.ts`). Not state: a change to it always comes with a dispatch.
  const [held] = useState(createHeldStore)
  // The accounts the admin approved for each run this page signs, by position: kept with
  // the held transactions, so signing one again checks it against the same approval.
  const [approvals] = useState(() => new Map<string, Payees>())
  const approve = useCallback(
    (runId: string, payees: Payees) => {
      const merged = approvedPayees([
        ...(approvals.get(runId) ?? []),
        ...payees,
      ])
      approvals.set(runId, merged)
      return merged
    },
    [approvals],
  )
  const working = useRef(false)
  const controller = useRef<AbortController | null>(null)

  useEffect(() => {
    const own = new AbortController()
    controller.current = own
    return () => own.abort()
  }, [])

  const contextFor = useCallback(
    (
      runId: string,
      personOf: PersonOf,
      payees: Payees,
      signal?: AbortSignal,
    ): RunContext => {
      const refreshRun = () =>
        queryClient.invalidateQueries({
          queryKey: queryKeys.runs.detail(runId),
        })
      return {
        runId,
        // The company's wallet, its own token account as this app derives it, and the
        // approved accounts: what every payment's transaction is checked against.
        sign: checkedSign(sign, async () => ({
          wallet: wallet.address,
          sender: await senderAccountFor(wallet.address),
          payees,
        })),
        api: runApi,
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
          personOf,
          Date.now,
          apiConfig.mode,
        ),
      }
    },
    [sign, wallet.address, queryClient, held, evidence],
  )

  // One tab at a time, and one thing at a time within it. `lease` is the run lock when
  // the caller already holds it (a run is created under it, then signed); otherwise it is
  // taken here, and refused while another tab has it. It is released when the task ends.
  const exclusive = useCallback(
    async (
      runId: string,
      personOf: PersonOf,
      payees: Payees,
      task: (context: RunContext) => Promise<unknown>,
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
        await task(
          contextFor(runId, personOf, payees, controller.current?.signal),
        )
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
          await recoverOne(
            latest.current(
              record.run_id,
              () => record.person_id,
              nobody,
              own.signal,
            ),
            record,
          )
          if (own.signal.aborted) return
          setChecking((current) => {
            const next = new Set(current)
            next.delete(paymentKey(record.run_id, record.position))
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
    // Signs a run just created, in position order, stopping at the first payment that
    // does not finalize. `payees` are the accounts the admin approved for it, by
    // position (`approvedPayees`).
    start: (
      created: Run,
      personOf: PersonOf,
      payees: Payees,
      lease?: Lease,
    ) => {
      for (const prepared of signablesOf(created)) {
        held.hold(paymentKey(created.run_id, prepared.position), prepared)
      }
      return exclusive(
        created.run_id,
        personOf,
        approve(created.run_id, payees),
        (context) => continueRun(context, held),
        lease,
      )
    },
    // Whether this page still holds the transaction of a payment not signed yet.
    holds: (runId: string, position: number) =>
      held.has(paymentKey(runId, position)),
    // Signs the held transactions again from a cancelled one, without preparing new
    // ones. Past its blockhash, it and the ones after it are let go of: not paid. They
    // are checked against what the admin approved when they were prepared.
    signAgain: (runId: string, personOf: PersonOf) =>
      exclusive(runId, personOf, approvals.get(runId) ?? nobody, (context) =>
        continueRun(context, held),
      ),
    // Prepares the run's failed payments again, with the amounts the admin approved for
    // them now, and signs them in order. The balance key is derived again for it.
    retry: (
      run: Run,
      amounts: ReadonlyMap<number, string>,
      personOf: PersonOf,
      payees: Payees,
    ) =>
      exclusive(
        run.run_id,
        personOf,
        approve(run.run_id, payees),
        async (context) => {
          const positions = retryablePositions(run).filter((p) =>
            amounts.has(p),
          )
          if (positions.length === 0) return
          let aesKey: string
          try {
            aesKey = await deriveBalanceKey(wallet.signer, run.sender)
          } catch (error) {
            for (const position of positions) {
              context.events.failed(paymentKey(run.run_id, position), error)
            }
            return
          }
          const rebuilt = await retryRun(context, run, {
            aes_key: aesKey,
            payments: positions.map((position) => ({
              position,
              amount: amounts.get(position) ?? "",
            })),
          })
          if (!rebuilt) return
          for (const prepared of rebuilt) {
            const key = paymentKey(run.run_id, prepared.position)
            held.hold(key, prepared)
            dispatch({ type: "reset", id: key })
          }
          await continueRun(context, held)
        },
      ),
    recheck: (
      runId: string,
      payment: { position: number; request_id: string },
      signature: string,
      personOf: PersonOf,
    ) =>
      exclusive(runId, personOf, nobody, (context) =>
        recheckOne(context, payment, signature),
      ),
  }
}

export type RunSigner = ReturnType<typeof useRunSigner>
