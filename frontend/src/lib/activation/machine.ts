import type { AccountStatus } from "@/lib/api/schemas"

// Activation in the order a person goes through it. The service reports each as an
// independent flag, so the order lives here, not in the status.
export const activationSteps = ["wallet", "key", "account"] as const
export type ActivationStep = (typeof activationSteps)[number]

export type StepsDone = Record<ActivationStep, boolean>

export function doneFromStatus(status: AccountStatus): StepsDone {
  return {
    wallet: status.wallet_linked,
    key: status.key_enrolled,
    account: status.account_configured,
  }
}

export const isActivated = (done: StepsDone) =>
  activationSteps.every((step) => done[step])

// What the service knows wins nothing over what this run already did: a step stays
// done if either side says so, so a retry never repeats work.
export function mergeDone(a: StepsDone, b: StepsDone): StepsDone {
  return {
    wallet: a.wallet || b.wallet,
    key: a.key || b.key,
    account: a.account || b.account,
  }
}

export function nextStep(done: StepsDone): ActivationStep | null {
  return activationSteps.find((step) => !done[step]) ?? null
}

export type ActivationState = {
  phase: "idle" | "running" | "failed" | "done"
  done: StepsDone
  current: ActivationStep | null
  // Kept as the thrown value; the screen shows copy for it, never the value.
  failure: { step: ActivationStep; error: unknown } | null
}

export type ActivationEvent =
  | { type: "synced"; done: StepsDone }
  | { type: "begun" }
  | { type: "started"; step: ActivationStep }
  | { type: "finished"; step: ActivationStep }
  | { type: "failed"; step: ActivationStep; error: unknown }
  | { type: "completed" }

export function initialState(status: AccountStatus): ActivationState {
  const done = doneFromStatus(status)
  return {
    phase: isActivated(done) ? "done" : "idle",
    done,
    current: null,
    failure: null,
  }
}

export function activationReducer(
  state: ActivationState,
  event: ActivationEvent,
): ActivationState {
  switch (event.type) {
    case "synced":
      return { ...state, done: mergeDone(state.done, event.done) }
    case "begun":
      return { ...state, phase: "running", current: null, failure: null }
    case "started":
      return { ...state, phase: "running", current: event.step }
    case "finished":
      return {
        ...state,
        done: { ...state.done, [event.step]: true },
        current: null,
      }
    case "failed":
      return {
        ...state,
        phase: "failed",
        current: null,
        failure: { step: event.step, error: event.error },
      }
    case "completed":
      return { ...state, phase: "done", current: null, failure: null }
  }
}

export type StepRunners = Record<ActivationStep, () => Promise<void>>

// Runs the steps not yet done, in order, and stops at the first failure: the caller
// starts again with what is done by then, so a retry resumes at the failed step.
export async function runActivation({
  done,
  runners,
  dispatch,
  signal,
  beforeComplete,
}: {
  done: StepsDone
  runners: StepRunners
  dispatch: (event: ActivationEvent) => void
  signal?: AbortSignal
  // Awaited once every step is done, before the run is reported complete.
  beforeComplete?: () => Promise<void>
}): Promise<void> {
  for (const step of activationSteps) {
    if (signal?.aborted) return
    if (done[step]) continue
    dispatch({ type: "started", step })
    try {
      await runners[step]()
    } catch (error) {
      // A person who left is not told about a step they stopped.
      if (signal?.aborted) return
      dispatch({ type: "failed", step, error })
      return
    }
    if (signal?.aborted) return
    dispatch({ type: "finished", step })
  }
  await beforeComplete?.()
  if (signal?.aborted) return
  dispatch({ type: "completed" })
}
