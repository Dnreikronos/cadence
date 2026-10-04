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
import { describeFailure } from "./messages"
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
          api: runApi,
          signal: controller.current?.signal,
          events: {
            signing: (id) => dispatch({ type: "signing", id }),
            waiting: (id) => dispatch({ type: "waiting", id }),
            submitted: (id, signature) =>
              dispatch({ type: "submitted", id, signature }),
            confirmed: (id) => {
              dispatch({ type: "confirmed", id })
              // Money moved: the sidebar balance and the payment lists are stale.
              void invalidateBalances(queryClient)
              void queryClient.invalidateQueries({
                queryKey: queryKeys.payments.all,
              })
              void refreshRun()
            },
            failed: (id, error) => {
              dispatch({ type: "failed", id, ...describeFailure(error) })
              void refreshRun()
            },
          },
        })
      } finally {
        working.current = false
        setBusy(false)
      }
    },
    [sign, queryClient],
  )

  return {
    wallet,
    local,
    busy,
    start: (created: RunCreated) =>
      exclusive(created.run_id, (context) =>
        paySequence(context, created.payments),
      ),
    retry: (runId: string, paymentId: string) =>
      exclusive(runId, (context) => retryOne(context, paymentId)),
    recheck: (runId: string, paymentId: string, signature: string) =>
      exclusive(runId, (context) => recheckOne(context, paymentId, signature)),
  }
}

export type RunSigner = ReturnType<typeof useRunSigner>
