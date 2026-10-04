"use client"

import { useQuery, useQueryClient } from "@tanstack/react-query"
import { useCallback, useEffect, useRef, useState } from "react"
import { toast } from "sonner"
import { api } from "@/lib/api"
import {
  canRetry,
  failureMessage,
  MakePrivateError,
  needsSetup,
  runMakePrivate,
  type Resume,
} from "@/lib/deposit/make-private"
import type { MakePrivateStep } from "@/lib/deposit/types"
import { formatUnits } from "@/lib/money"
import { readPublicUsdc } from "@/lib/solana/balances"
import { useSignAndConfirm } from "@/lib/wallet/context"
import { invalidateBalances } from "./invalidate"
import { queryKeys } from "./keys"

// The company's USDC that anyone can see on-chain, in base units. Money arrives
// from outside the app, so it is refreshed while the screen is open.
export function usePublicUsdc(wallet: string) {
  return useQuery({
    queryKey: queryKeys.deposit.publicUsdc(wallet),
    queryFn: ({ signal }) => readPublicUsdc(wallet, signal),
    enabled: wallet !== "",
    refetchInterval: 20_000,
  })
}

// The private balance, same answer as the sidebar's but keyed by the wallet.
export function useCompanyBalance(wallet: string) {
  return useQuery({
    queryKey: queryKeys.balance.companyWallet(wallet),
    queryFn: ({ signal }) => api.company.balance({ signal }),
    enabled: wallet !== "",
  })
}

export type MakePrivateState =
  | { status: "idle" }
  | { status: "running"; step: MakePrivateStep }
  | {
      status: "failed"
      step: MakePrivateStep
      resume: Resume
      message: string
      setupRequired: boolean
      retryable: boolean
    }
  // `amount` is absent when only a pending credit was made available.
  | { status: "done"; amount?: string }

// Make a deposit private: wrap, sign, then apply the pending credit. Leaving the
// screen stops the flow before anything more is sent; a deposit that already
// landed shows up as pending and can be applied from the screen later.
export function useMakePrivate(wallet: string) {
  const queryClient = useQueryClient()
  const signAndConfirm = useSignAndConfirm()
  const [state, setState] = useState<MakePrivateState>({ status: "idle" })
  const running = useRef(false)
  const controller = useRef<AbortController | null>(null)
  // The amount of the deposit in flight, for a retry of its wrap step.
  const amount = useRef("")

  useEffect(() => () => controller.current?.abort(), [])

  const refresh = useCallback(() => {
    void invalidateBalances(queryClient)
    void queryClient.invalidateQueries({ queryKey: queryKeys.deposit.all })
  }, [queryClient])

  const start = useCallback(
    async (from: "wrap" | "apply") => {
      if (running.current) return
      running.current = true
      const abort = new AbortController()
      controller.current = abort
      setState({
        status: "running",
        step: from === "wrap" ? "preparing" : "applying",
      })
      try {
        await runMakePrivate({
          from,
          amount: amount.current,
          wallet,
          api,
          signAndConfirm,
          signal: abort.signal,
          onStep: (step) => setState({ status: "running", step }),
          // Each confirmed transaction moved money, whether or not the next step works.
          onConfirmed: refresh,
        })
        const done = amount.current || undefined
        toast.success(
          done
            ? `${formatUnits(done)} is now private`
            : "Your pending USDC is now available",
        )
        setState({ status: "done", amount: done })
      } catch (error) {
        if (abort.signal.aborted) return
        const failure =
          error instanceof MakePrivateError
            ? error
            : new MakePrivateError("preparing", "wrap", error)
        setState({
          status: "failed",
          step: failure.step,
          resume: failure.resume,
          message: failureMessage(failure),
          setupRequired: needsSetup(failure),
          retryable: canRetry(failure),
        })
      } finally {
        running.current = false
      }
    },
    [wallet, signAndConfirm, refresh],
  )

  return {
    state,
    // `units` is an integer base-unit string, already validated.
    deposit: (units: string) => {
      amount.current = units
      return start("wrap")
    },
    applyPending: () => {
      amount.current = ""
      return start("apply")
    },
    retry: () => {
      if (state.status !== "failed") return
      if (state.resume === "check") return
      return start(state.resume)
    },
    // After an unknown outcome: look at the balances instead of sending again.
    check: () => {
      refresh()
      setState({ status: "idle" })
    },
    dismiss: () => setState({ status: "idle" }),
  }
}
