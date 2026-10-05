"use client"

import { useQuery, useQueryClient } from "@tanstack/react-query"
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react"
import { toast } from "sonner"
import { api } from "@/lib/api"
import { apiConfig } from "@/lib/api/mode"
import { acquireFlowLock, flowLockName } from "@/lib/flow-lock"
import { requireDurable } from "@/lib/storage-guard"
import {
  MakePrivateController,
  SUBMISSION_KIND,
  type Deps,
} from "@/lib/deposit/controller"
import { readPublicUsdc } from "@/lib/solana/balances"
import { submissionStore } from "@/lib/submissions"
import { useSignAndConfirm } from "@/lib/wallet/context"
import { invalidateBalances } from "./invalidate"
import { queryKeys, type ViewerScope } from "./keys"

// How old a balance may be and still say what was pending when a deposit started.
const PENDING_FRESH_MS = 60_000

export type { MakePrivateState } from "@/lib/deposit/controller"

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

// Make a deposit private: wrap, sign, then apply the pending credit. Leaving the
// screen stops the flow before anything more is sent. A wrap already handed to
// the network is recorded for the viewer, and checked when the screen comes back (in
// this tab or another), before another can be sent. One tab at a time works on it.
export function useMakePrivate(wallet: string, viewer: ViewerScope) {
  const queryClient = useQueryClient()
  const signAndConfirm = useSignAndConfirm()
  const { email, company, companyId } = viewer
  const store = useMemo(
    () => submissionStore(SUBMISSION_KIND, { email, company, companyId }),
    [email, company, companyId],
  )
  const deps = useRef<Deps>(null as never)
  deps.current = {
    wallet,
    api,
    signAndConfirm,
    refresh: () => {
      void invalidateBalances(queryClient)
      void queryClient.invalidateQueries({ queryKey: queryKeys.deposit.all })
    },
    // Unknown unless the balance was read lately: an old reading may predate a deposit.
    pendingUnits: () => {
      const key = queryKeys.balance.companyWallet(wallet)
      const state = queryClient.getQueryState<{ pending: string }>(key)
      const fresh = Date.now() - (state?.dataUpdatedAt ?? 0) < PENDING_FRESH_MS
      return fresh && !state?.isInvalidated ? state?.data?.pending : undefined
    },
    toast: (message) => toast.success(message),
    // No send without a record of it, in real mode.
    requireStorage: () => requireDurable(apiConfig.mode),
    store,
    lock: () => acquireFlowLock(flowLockName("deposit", viewer)),
  }
  const [controller] = useState(
    () => new MakePrivateController(() => deps.current),
  )
  const state = useSyncExternalStore(
    controller.subscribe,
    controller.getState,
    controller.getState,
  )

  useEffect(() => {
    controller.start()
    return () => controller.dispose()
  }, [controller])

  // A sent wrap is not undone by leaving: say so before the tab closes.
  const inFlight = controller.inFlight
  useEffect(() => {
    if (!inFlight) return
    const warn = (event: BeforeUnloadEvent) => event.preventDefault()
    window.addEventListener("beforeunload", warn)
    return () => window.removeEventListener("beforeunload", warn)
  }, [inFlight])

  return {
    state,
    // `units` is an integer base-unit string, already validated.
    deposit: (units: string) => controller.deposit(units),
    applyPending: () => controller.applyPending(),
    retry: () => controller.retry(),
    check: () => controller.check(),
    checkAgain: () => controller.checkAgain(),
    dismiss: () => controller.dismiss(),
  }
}
