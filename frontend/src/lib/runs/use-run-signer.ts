"use client"

import { useCallback, useEffect, useReducer, useRef, useState } from "react"
import { useQueryClient } from "@tanstack/react-query"
import { api } from "@/lib/api"
import type { RunCreated } from "@/lib/api/schemas"
import { invalidateBalances } from "@/lib/queries/invalidate"
import { queryKeys } from "@/lib/queries/keys"
import { useSignAndConfirm, useWallet } from "@/lib/wallet/context"
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

const runApi: RunApi = {
  confirmPayment: (runId, paymentId, signature) =>
    api.runs.confirmPayment(runId, paymentId, signature),
  retryPayment: (runId, paymentId) => api.runs.retryPayment(runId, paymentId),
}

// Signs payroll payments with the user's wallet, one at a time, and keeps what this
// browser is doing to each one. Leaving the page stops it: the unsigned payments stay as
// they were. Only one thing is signed at a time, so a call while busy is ignored.
export function useRunSigner() {
  const wallet = useWallet()
  const sign = useSignAndConfirm()
  const queryClient = useQueryClient()
  const [local, dispatch] = useReducer(localReducer, {})
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

  const exclusive = useCallback(
    async (runId: string, task: (context: RunContext) => Promise<void>) => {
      if (working.current) return
      working.current = true
      setBusy(true)
      const refreshRun = () =>
        queryClient.invalidateQueries({
          queryKey: queryKeys.runs.detail(runId),
        })
      try {
        await task({
          runId,
          sign,
          api: holdingRetries(runApi, held),
          signal: controller.current?.signal,
          events: runEvents(held, dispatch, {
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
        })
      } finally {
        working.current = false
        setBusy(false)
      }
    },
    [sign, queryClient, held],
  )

  return {
    wallet,
    local,
    busy,
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
