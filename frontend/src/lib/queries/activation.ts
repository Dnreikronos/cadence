"use client"

import { useEffect, useReducer, useRef } from "react"
import { useQueryClient } from "@tanstack/react-query"
import { api } from "@/lib/api"
import type { AccountStatus } from "@/lib/api/schemas"
import { activationReducer, initialState } from "@/lib/activation/machine"
import { startActivation, type StartGuard } from "@/lib/activation/start"
import { createRunners, type ConfigureAttempts } from "@/lib/activation/steps"
import { useSignAndConfirm, useWallet } from "@/lib/wallet/context"
import { invalidateBalances } from "./invalidate"
import type { ViewerScope } from "./keys"
import { accountStatusOptions } from "./status"

// A configure transaction that was submitted outlives the screen, so leaving and
// coming back settles it rather than preparing a second one. Public values only.
const configureAttempts: ConfigureAttempts = new Map()

// Runs activation from the account status it opens with, and again from wherever it
// failed: `start` asks the service what is done now and skips those steps. Nothing a
// step handles (the key-derivation signature above all) is kept in state or in a
// mutation's variables; the screen gets steps and failures, never values.
export function useActivation(initial: AccountStatus, viewer: ViewerScope) {
  const queryClient = useQueryClient()
  const wallet = useWallet()
  const run = useSignAndConfirm()
  const [state, dispatch] = useReducer(activationReducer, initial, initialState)
  const guard = useRef<StartGuard>({ busy: false, controller: null })

  // Leaving stops the run between steps; the service keeps what was done.
  useEffect(() => {
    const current = guard.current
    return () => current.controller?.abort()
  }, [])

  const start = () =>
    startActivation({
      guard: guard.current,
      done: state.done,
      dispatch,
      // Through the query cache, so /me and the shell see what this read saw.
      readStatus: () =>
        queryClient.fetchQuery({
          ...accountStatusOptions(viewer),
          staleTime: 0,
        }),
      makeRunners: (signal) =>
        createRunners({
          api,
          wallet,
          run,
          signal,
          attempts: configureAttempts,
        }),
      // A balance that could not be read before the account existed can be now.
      afterVerified: () => invalidateBalances(queryClient).catch(() => {}),
    })

  return { state, start, wallet }
}
