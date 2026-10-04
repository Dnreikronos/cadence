import { describe, expect, it, vi } from "vitest"
import type { AccountStatus } from "@/lib/api/schemas"
import {
  activationReducer,
  activationSteps,
  doneFromStatus,
  initialState,
  isActivated,
  mergeDone,
  nextStep,
  runActivation,
  type ActivationEvent,
  type ActivationState,
  type ActivationStep,
  type StepRunners,
  type StepsDone,
} from "./machine"

const status = (over: Partial<AccountStatus> = {}): AccountStatus => ({
  wallet_linked: false,
  key_enrolled: false,
  account_configured: false,
  pending_credits: false,
  ...over,
})

const none: StepsDone = { wallet: false, key: false, account: false }

// Runners that record the order they ran in, and fail where told to.
function runners(failAt: Partial<Record<ActivationStep, unknown>> = {}) {
  const calls: ActivationStep[] = []
  const make = (step: ActivationStep) => async () => {
    calls.push(step)
    if (step in failAt) throw failAt[step]
  }
  const set: StepRunners = {
    wallet: make("wallet"),
    key: make("key"),
    account: make("account"),
  }
  return { calls, set }
}

// Plays a run through the reducer, as the hook does.
async function play(
  state: ActivationState,
  set: StepRunners,
  signal?: AbortSignal,
) {
  let current = state
  const events: ActivationEvent[] = []
  await runActivation({
    done: current.done,
    runners: set,
    signal,
    dispatch: (event) => {
      events.push(event)
      current = activationReducer(current, event)
    },
  })
  return { state: current, events }
}

describe("doneFromStatus", () => {
  it("maps each flag to its step, and ignores pending credits", () => {
    expect(
      doneFromStatus(status({ wallet_linked: true, account_configured: true })),
    ).toEqual({ wallet: true, key: false, account: true })
    expect(doneFromStatus(status({ pending_credits: true }))).toEqual(none)
  })
})

describe("isActivated and nextStep", () => {
  it("needs all three steps, and points at the first one missing", () => {
    expect(isActivated(none)).toBe(false)
    expect(isActivated({ wallet: true, key: true, account: false })).toBe(false)
    expect(isActivated({ wallet: true, key: true, account: true })).toBe(true)
    expect(nextStep(none)).toBe("wallet")
    expect(nextStep({ wallet: true, key: false, account: true })).toBe("key")
    expect(nextStep({ wallet: true, key: true, account: true })).toBeNull()
  })

  it("does not read the flags as a sequence", () => {
    // Configured without a recorded enrollment: the key step is still to do.
    const done = doneFromStatus(
      status({ wallet_linked: true, account_configured: true }),
    )
    expect(nextStep(done)).toBe("key")
    expect(isActivated(done)).toBe(false)
  })
})

describe("mergeDone", () => {
  it("keeps a step done when either side says so", () => {
    expect(
      mergeDone(
        { wallet: true, key: false, account: false },
        { wallet: false, key: true, account: false },
      ),
    ).toEqual({ wallet: true, key: true, account: false })
  })
})

describe("initialState", () => {
  it("starts idle with what the service already knows", () => {
    expect(initialState(status({ wallet_linked: true }))).toEqual({
      phase: "idle",
      done: { wallet: true, key: false, account: false },
      current: null,
      failure: null,
    })
  })

  it("starts done for an account that is already set up", () => {
    const state = initialState(
      status({
        wallet_linked: true,
        key_enrolled: true,
        account_configured: true,
      }),
    )
    expect(state.phase).toBe("done")
  })
})

describe("runActivation", () => {
  it("runs the three steps in order from a fresh account", async () => {
    const { calls, set } = runners()
    const { state, events } = await play(initialState(status()), set)
    expect(calls).toEqual(["wallet", "key", "account"])
    expect(state.phase).toBe("done")
    expect(isActivated(state.done)).toBe(true)
    expect(events.map((e) => e.type)).toEqual([
      "started",
      "finished",
      "started",
      "finished",
      "started",
      "finished",
      "completed",
    ])
  })

  it.each<[string, Partial<AccountStatus>, ActivationStep[]]>([
    ["the wallet is linked", { wallet_linked: true }, ["key", "account"]],
    [
      "the key is enrolled too",
      { wallet_linked: true, key_enrolled: true },
      ["account"],
    ],
    [
      "only the account is configured",
      { account_configured: true },
      ["wallet", "key"],
    ],
  ])("resumes at the first step still to do when %s", async (_, over, ran) => {
    const { calls, set } = runners()
    const { state } = await play(initialState(status(over)), set)
    expect(calls).toEqual(ran)
    expect(state.phase).toBe("done")
  })

  it.each(activationSteps)(
    "stops at a failure in %s and runs nothing after it",
    async (step) => {
      const error = new Error("boom")
      const { calls, set } = runners({ [step]: error })
      const { state } = await play(initialState(status()), set)
      const failedAt = activationSteps.indexOf(step)
      expect(calls).toEqual(activationSteps.slice(0, failedAt + 1))
      expect(state.phase).toBe("failed")
      expect(state.failure).toEqual({ step, error })
      // What came before is done; the failed step and what follows are not.
      expect(state.done).toEqual({
        wallet: failedAt > 0,
        key: failedAt > 1,
        account: false,
      })
      expect(state.current).toBeNull()
    },
  )

  it.each(activationSteps)(
    "retries from %s, not from the start, once it works",
    async (step) => {
      const failing = runners({ [step]: new Error("boom") })
      const failed = await play(initialState(status()), failing.set)
      expect(failed.state.phase).toBe("failed")

      const retry = runners()
      const retried = await play(
        activationReducer(failed.state, { type: "begun" }),
        retry.set,
      )
      expect(retry.calls).toEqual(
        activationSteps.slice(activationSteps.indexOf(step)),
      )
      expect(retried.state.phase).toBe("done")
      expect(retried.state.failure).toBeNull()
    },
  )

  it("can fail again on the retry, at the same step", async () => {
    const first = await play(
      initialState(status()),
      runners({ key: new Error("one") }).set,
    )
    const second = await play(
      activationReducer(first.state, { type: "begun" }),
      runners({ key: new Error("two") }).set,
    )
    expect(second.state.failure?.step).toBe("key")
    expect(second.state.done.wallet).toBe(true)
  })

  it("skips a step the service now reports as done, after a lost answer", async () => {
    // The key step failed on this device, but the service did enroll it.
    const failed = await play(
      initialState(status()),
      runners({ key: new Error("timeout") }).set,
    )
    const synced = activationReducer(
      activationReducer(failed.state, { type: "begun" }),
      { type: "synced", done: doneFromStatus(status({ key_enrolled: true })) },
    )
    const retry = runners()
    await play(synced, retry.set)
    expect(retry.calls).toEqual(["account"])
  })

  it("waits for beforeComplete, and reports done only after it", async () => {
    const order: string[] = []
    await runActivation({
      done: { wallet: true, key: true, account: true },
      runners: runners().set,
      dispatch: (event) => order.push(event.type),
      beforeComplete: async () => {
        order.push("before")
      },
    })
    expect(order).toEqual(["before", "completed"])
  })

  it("stays silent when the person has left", async () => {
    const controller = new AbortController()
    const calls: ActivationStep[] = []
    const set: StepRunners = {
      wallet: async () => {
        calls.push("wallet")
      },
      key: async () => {
        calls.push("key")
        controller.abort()
        throw new Error("aborted mid-step")
      },
      account: async () => {
        calls.push("account")
      },
    }
    const dispatch = vi.fn()
    await runActivation({
      done: none,
      runners: set,
      dispatch,
      signal: controller.signal,
    })
    expect(calls).toEqual(["wallet", "key"])
    expect(dispatch.mock.calls.map(([e]) => e.type)).toEqual([
      "started",
      "finished",
      "started",
    ])
  })
})

describe("activationReducer", () => {
  it("clears the failure when a retry begins", () => {
    const failed = activationReducer(initialState(status()), {
      type: "failed",
      step: "key",
      error: new Error("x"),
    })
    const begun = activationReducer(failed, { type: "begun" })
    expect(begun).toMatchObject({ phase: "running", failure: null })
  })
})
