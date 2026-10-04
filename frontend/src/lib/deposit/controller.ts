import type { ApiClient } from "@/lib/api/client"
import { formatBaseUnits } from "@/lib/deposit/schema"
import type { Submission } from "@/lib/submissions"
import {
  canRetry,
  failureMessage,
  MakePrivateError,
  needsSetup,
  runMakePrivate,
  type Resume,
} from "./make-private"
import { reconcileWrap, type Reconciled } from "./reconcile"
import type { MakePrivateStep } from "./types"

export const SUBMISSION_KIND = "wrap"

export type MakePrivateState =
  | { status: "idle" }
  | { status: "running"; step: MakePrivateStep }
  // Finding out what became of a wrap sent earlier, before anything new is sent.
  | { status: "checking" }
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
  // What the check of an earlier wrap found. Informational: the form is free.
  | { status: "resolved"; outcome: Reconciled }

export type Deps = {
  wallet: string
  api: Pick<ApiClient, "wrap" | "accounts">
  signAndConfirm: Parameters<typeof runMakePrivate>[0]["signAndConfirm"]
  // Balances changed (a transaction confirmed, or a check ended).
  refresh: () => void
  toast: (message: string) => void
  store: {
    read: () => Submission | null
    record: (record: Omit<Submission, "at"> & { at?: number }) => Submission
    clear: () => void
  }
  now?: () => number
  sleep?: Parameters<typeof reconcileWrap>[0]["sleep"]
}

// "2500 USDC", exact: a sub-cent amount must not read as $0.00.
export const describeUsdc = (units: string) =>
  `${formatBaseUnits(BigInt(units))} USDC`

// The make-private flow as a small state machine, with no React in it so its
// ordering and its failures can be tested. `useMakePrivate` wraps it.
export class MakePrivateController {
  private state: MakePrivateState
  private listeners = new Set<() => void>()
  private running = false
  private abort: AbortController | null = null
  // The amount of the deposit in flight, for a retry of its wrap step.
  private amount = ""
  private record: Submission | null = null
  // Whatever is running now; a stale run never touches the state or the flag.
  private generation = 0

  constructor(private readonly getDeps: () => Deps) {
    // A wrap sent earlier and not seen through blocks a new one until it is.
    const earlier = this.getDeps().store.read()
    this.state =
      earlier && earlier.wallet === this.getDeps().wallet
        ? { status: "checking" }
        : { status: "idle" }
  }

  getState = () => this.state

  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => void this.listeners.delete(listener)
  }

  // Safe to call again after `dispose` (a strict-mode remount does).
  start() {
    if (this.state.status === "checking") void this.reconcile()
  }

  // Leaving the screen: stop before anything more is sent. A wrap already
  // handed to the network stays recorded and is checked on return.
  dispose() {
    this.generation++
    this.abort?.abort()
    this.abort = null
    this.running = false
  }

  // True while a wrap has been handed to the network and not seen through.
  get inFlight() {
    return (
      (this.state.status === "running" &&
        (this.state.step === "confirming" || this.state.step === "applying")) ||
      this.state.status === "checking"
    )
  }

  deposit(units: string) {
    this.amount = units
    return this.begin("wrap")
  }

  applyPending() {
    this.amount = ""
    return this.begin("apply")
  }

  retry() {
    const state = this.state
    if (state.status !== "failed" || state.resume === "check") return
    return this.begin(state.resume)
  }

  // After an unknown outcome: look instead of sending again.
  check() {
    if (this.running) return
    if (this.getDeps().store.read()) {
      this.set({ status: "checking" })
      return this.reconcile()
    }
    this.getDeps().refresh()
    this.set({ status: "idle" })
  }

  dismiss() {
    if (this.running) return
    this.set({ status: "idle" })
  }

  private set(state: MakePrivateState) {
    const now = this.state
    // The same step again is not news.
    if (
      now.status === "running" &&
      state.status === "running" &&
      now.step === state.step
    ) {
      return
    }
    this.state = state
    for (const listener of [...this.listeners]) listener()
  }

  private begin(from: "wrap" | "apply") {
    if (this.running || this.state.status === "checking") return
    // A wrap sent and not seen through blocks another, whatever the screen shows.
    if (from === "wrap") {
      const { store, wallet } = this.getDeps()
      if (store.read()?.wallet === wallet) return
    }
    const generation = ++this.generation
    const abort = new AbortController()
    this.abort = abort
    this.running = true
    return this.run(from, generation, abort)
  }

  private live(generation: number) {
    return generation === this.generation
  }

  private async run(
    from: "wrap" | "apply",
    generation: number,
    abort: AbortController,
  ) {
    const deps = this.getDeps()
    const { store } = deps
    this.set({
      status: "running",
      step: from === "wrap" ? "preparing" : "applying",
    })
    try {
      await runMakePrivate({
        from,
        amount: this.amount,
        wallet: deps.wallet,
        api: deps.api,
        signAndConfirm: deps.signAndConfirm,
        signal: abort.signal,
        onStep: (step) => {
          if (this.live(generation)) this.set({ status: "running", step })
        },
        onSubmitting: (wrap) => {
          this.record = store.record({
            kind: SUBMISSION_KIND,
            request_id: wrap.request_id,
            signature: null,
            last_valid_block_height: wrap.last_valid_block_height,
            wallet: deps.wallet,
            at: (deps.now ?? Date.now)(),
          })
        },
        onSubmitted: (signature) => {
          if (this.record) {
            this.record = store.record({ ...this.record, signature })
          }
        },
        onConfirmed: (which) => {
          // The wrap is seen through: nothing is left to look for.
          if (which === "wrap") {
            store.clear()
            this.record = null
          }
          deps.refresh()
        },
      })
      if (!this.live(generation)) return
      const done = this.amount || undefined
      deps.toast(
        done
          ? `${describeUsdc(done)} is now private`
          : "Your pending USDC is now available",
      )
      this.set({ status: "done", amount: done })
    } catch (error) {
      if (!this.live(generation) || abort.signal.aborted) return
      const failure =
        error instanceof MakePrivateError
          ? error
          : new MakePrivateError("preparing", "wrap", error)
      // Only an outcome that cannot be told keeps the record; otherwise nothing
      // is in flight and a stale record would block the next deposit.
      if (failure.resume !== "check") store.clear()
      this.set({
        status: "failed",
        step: failure.step,
        resume: failure.resume,
        message: failureMessage(failure),
        setupRequired: needsSetup(failure),
        retryable: canRetry(failure),
      })
    } finally {
      if (this.live(generation)) this.running = false
    }
  }

  private async reconcile() {
    const deps = this.getDeps()
    const record = deps.store.read()
    if (!record || record.wallet !== deps.wallet) {
      this.set({ status: "idle" })
      return
    }
    if (this.running) return
    const generation = ++this.generation
    const abort = new AbortController()
    this.abort = abort
    this.running = true
    try {
      const outcome = await reconcileWrap({
        record,
        api: deps.api,
        signal: abort.signal,
        now: deps.now,
        sleep: deps.sleep,
      })
      if (!this.live(generation)) return
      deps.store.clear()
      deps.refresh()
      this.set({ status: "resolved", outcome })
    } catch {
      if (!this.live(generation) || abort.signal.aborted) return
      // The service could not be asked. Keep the record and the lock, and let
      // the person ask again.
      this.set({
        status: "failed",
        step: "confirming",
        resume: "check",
        message: "We couldn't check your last deposit. Try again in a moment.",
        setupRequired: false,
        retryable: false,
      })
    } finally {
      if (this.live(generation)) this.running = false
    }
  }
}
