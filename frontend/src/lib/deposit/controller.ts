import type { ApiClient } from "@/lib/api/client"
import type { Submission } from "@/lib/submissions"
import {
  canRetry,
  failureMessage,
  MakePrivateError,
  needsSetup,
  runMakePrivate,
  sentApplyMessage,
  type Resume,
  type SentApply,
} from "./make-private"
import {
  doneToast,
  earlierFromBalance,
  earlierFromRecord,
  earlierToRecord,
  type EarlierPending,
} from "./message"
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
      // An apply went out and was not seen through, and its signature is known: it
      // can be asked about again (`checkAgain`), which prepares nothing.
      recheck: boolean
    }
  // `amount` is absent when only a pending credit was made available.
  | { status: "done"; amount?: string; earlierPending?: EarlierPending }
  // What the check of an earlier wrap found. Informational: the form is free.
  | {
      status: "resolved"
      outcome: Reconciled
      earlierPending?: EarlierPending
    }

export type Deps = {
  wallet: string
  api: Pick<ApiClient, "wrap" | "accounts">
  signAndConfirm: Parameters<typeof runMakePrivate>[0]["signAndConfirm"]
  // The private balance's pending credit right now, in base units, read when a deposit
  // starts: what applying the credit will make available besides the new amount.
  pendingUnits?: () => string | undefined
  // Balances changed (a transaction confirmed, or a check ended).
  refresh: () => void
  toast: (message: string) => void
  store: {
    read: () => Submission | null
    record: (record: Omit<Submission, "at"> & { at?: number }) => Submission
    clear: () => void
  }
  // Throws when a record of the send cannot be kept and the mode forbids sending without
  // one (`requireDurable`): asked before a flow starts, and again right after the record
  // of the wrap is written, before the send.
  requireStorage?: () => void
  now?: () => number
  sleep?: Parameters<typeof reconcileWrap>[0]["sleep"]
}

export { describeUsdc } from "./message"

// The make-private flow as a small state machine, with no React in it so its
// ordering and its failures can be tested. `useMakePrivate` wraps it.
export class MakePrivateController {
  private state: MakePrivateState
  private listeners = new Set<() => void>()
  private running = false
  private abort: AbortController | null = null
  // The amount of the deposit in flight, for a retry of its wrap step.
  private amount = ""
  // What was already pending when that deposit started.
  private earlierPending: EarlierPending = null
  private record: Submission | null = null
  // The apply that went out and was not seen through, when there is one.
  private sentApply: (SentApply & { at: number }) | null = null
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
    this.earlierPending = earlierFromBalance(this.getDeps().pendingUnits?.())
    return this.begin("wrap")
  }

  applyPending() {
    this.amount = ""
    this.earlierPending = undefined
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
    this.sentApply = null
    this.set({ status: "idle" })
  }

  // After an apply that went out, when its signature is known: ask the service about
  // that same transaction again, which prepares nothing. Only the network dropping it
  // (or a blockhash that ran out with the service never seeing it) lets another apply
  // be offered; anything unclear stays a check.
  async checkAgain() {
    const sent = this.sentApply
    if (this.running || this.state.status !== "failed") return
    if (!sent?.signature) return
    const deps = this.getDeps()
    const generation = ++this.generation
    const abort = new AbortController()
    this.abort = abort
    this.running = true
    this.set({ status: "checking" })
    const failed = (message: string, resume: Resume, retryable: boolean) =>
      this.set({
        status: "failed",
        step: "applying",
        resume,
        message,
        setupRequired: false,
        retryable,
        recheck: resume === "check",
      })
    try {
      const outcome = await reconcileWrap({
        record: {
          request_id: sent.request_id,
          signature: sent.signature,
          at: sent.at,
        },
        // Only the confirm call is read, and it is the apply's own.
        api: { wrap: { confirm: deps.api.accounts.confirmApplyPending } },
        signal: abort.signal,
        now: deps.now,
        sleep: deps.sleep,
      })
      if (!this.live(generation)) return
      deps.refresh()
      if (outcome === "unknown") {
        failed(sentApplyMessage, "check", false)
        return
      }
      this.sentApply = null
      if (outcome === "failed") {
        failed(
          "Making your deposit available didn't go through. You can try again.",
          "apply",
          true,
        )
        return
      }
      const done = {
        amount: this.amount || undefined,
        earlierPending: this.amount ? this.earlierPending : undefined,
      }
      deps.toast(doneToast(done))
      this.set({ status: "done", ...done })
    } catch {
      if (!this.live(generation) || abort.signal.aborted) return
      // The service could not be asked: it stays a check, with the signature kept.
      failed(
        "We couldn't check your deposit. Try again in a moment.",
        "check",
        false,
      )
    } finally {
      if (this.live(generation)) this.running = false
    }
  }

  dismiss() {
    if (this.running) return
    this.sentApply = null
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
    // An apply that went out is looked into first, whatever the screen shows.
    if (from === "apply" && this.sentApply) return
    this.sentApply = null
    try {
      this.getDeps().requireStorage?.()
    } catch (error) {
      this.set({
        status: "failed",
        step: from === "wrap" ? "preparing" : "applying",
        resume: from,
        message: failureMessage(error),
        setupRequired: false,
        retryable: true,
        recheck: false,
      })
      return
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
            earlier_pending: earlierToRecord(this.earlierPending),
            at: (deps.now ?? Date.now)(),
          })
          // A record that could not be kept stops the wrap before it is sent.
          deps.requireStorage?.()
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
      const done = {
        amount: this.amount || undefined,
        earlierPending: this.amount ? this.earlierPending : undefined,
      }
      deps.toast(doneToast(done))
      this.set({ status: "done", ...done })
    } catch (error) {
      if (!this.live(generation) || abort.signal.aborted) return
      const failure =
        error instanceof MakePrivateError
          ? error
          : new MakePrivateError("preparing", "wrap", error)
      // Only an outcome that cannot be told keeps the record; otherwise nothing
      // is in flight and a stale record would block the next deposit.
      if (failure.resume !== "check") store.clear()
      // An apply that went out is kept in memory, to ask about it again. Unlike the
      // wrap it is not persisted: a reload forgets it, and the balances tell.
      this.sentApply = failure.sent
        ? { ...failure.sent, at: (deps.now ?? Date.now)() }
        : null
      this.set({
        status: "failed",
        step: failure.step,
        resume: failure.resume,
        message: failureMessage(failure),
        setupRequired: needsSetup(failure),
        retryable: canRetry(failure),
        recheck: !!failure.sent?.signature,
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
      this.set({
        status: "resolved",
        outcome,
        earlierPending: earlierFromRecord(record.earlier_pending),
      })
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
        recheck: false,
      })
    } finally {
      if (this.live(generation)) this.running = false
    }
  }
}
