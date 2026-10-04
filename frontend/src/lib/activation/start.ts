import type { AccountStatus } from "@/lib/api/schemas"
import {
  doneFromStatus,
  mergeDone,
  runActivation,
  type ActivationEvent,
  type StepRunners,
  type StepsDone,
} from "./machine"

// What one screen keeps between presses of the button.
export type StartGuard = { busy: boolean; controller: AbortController | null }

// One press of the button: ask the service what is done now, merge it with what this
// run did, run the steps still to do, then ask again before calling it complete. A
// second press while one is running does nothing.
export async function startActivation({
  guard,
  done,
  dispatch,
  readStatus,
  makeRunners,
  afterVerified,
}: {
  guard: StartGuard
  done: StepsDone
  dispatch: (event: ActivationEvent) => void
  // A fresh read of me.status, not a cached one.
  readStatus: () => Promise<AccountStatus>
  makeRunners: (signal: AbortSignal) => StepRunners
  afterVerified?: () => Promise<void>
}): Promise<void> {
  if (guard.busy) return
  guard.busy = true
  const abort = new AbortController()
  guard.controller = abort
  try {
    dispatch({ type: "begun" })
    let current = done
    try {
      const fresh = doneFromStatus(await readStatus())
      dispatch({ type: "synced", done: fresh })
      current = mergeDone(current, fresh)
    } catch {
      // Cannot ask: go on with what this run knows.
    }
    await runActivation({
      done: current,
      runners: makeRunners(abort.signal),
      dispatch,
      signal: abort.signal,
      verify: async () => doneFromStatus(await readStatus()),
      beforeComplete: afterVerified,
    })
  } finally {
    guard.busy = false
  }
}
