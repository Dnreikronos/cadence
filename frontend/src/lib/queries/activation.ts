"use client"

import { useEffect, useReducer, useRef } from "react"
import { useQueryClient } from "@tanstack/react-query"
import { api } from "@/lib/api"
import type { AccountStatus } from "@/lib/api/schemas"
import {
  activationReducer,
  doneFromStatus,
  initialState,
  mergeDone,
  runActivation,
} from "@/lib/activation/machine"
import { settleActivated } from "@/lib/activation/settle"
import { createRunners } from "@/lib/activation/steps"
import { useSignAndConfirm, useWallet } from "@/lib/wallet/context"
import { accountStatusOptions } from "./status"

// Runs activation from the account status it opens with, and again from wherever it
// failed: `start` asks the service what is done now and skips those steps. Nothing a
// step handles (the key-derivation signature above all) is kept in state or in a
// mutation's variables; the screen gets steps and failures, never values.
export function useActivation(initial: AccountStatus) {
  const queryClient = useQueryClient()
  const wallet = useWallet()
  const run = useSignAndConfirm()
  const [state, dispatch] = useReducer(activationReducer, initial, initialState)
  const controller = useRef<AbortController | null>(null)
  const busy = useRef(false)

  // Leaving stops the run between steps; the service keeps what was done.
  useEffect(() => () => controller.current?.abort(), [])

  async function start() {
    if (busy.current) return
    busy.current = true
    const abort = new AbortController()
    controller.current = abort
    dispatch({ type: "begun" })
    let done = state.done
    try {
      const fresh = doneFromStatus(
        await queryClient.fetchQuery({
          ...accountStatusOptions(),
          staleTime: 0,
        }),
      )
      dispatch({ type: "synced", done: fresh })
      done = mergeDone(done, fresh)
    } catch {
      // Cannot ask: go on with what this run knows.
    }
    try {
      await runActivation({
        done,
        runners: createRunners({ api, wallet, run, signal: abort.signal }),
        dispatch,
        signal: abort.signal,
        beforeComplete: () => settleActivated(queryClient),
      })
    } finally {
      busy.current = false
    }
  }

  return { state, start, wallet }
}
