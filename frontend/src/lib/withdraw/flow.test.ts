import { describe, expect, it, vi } from "vitest"
import { ApiError } from "@/lib/api/errors"
import type { Receipt, UnwrapPrepared } from "@/lib/api/schemas"
import { ConfirmTimeoutError, UnexpectedSignerError } from "@/lib/api/sign"
import { WalletUnavailableError } from "@/lib/wallet/types"
import {
  failureOf,
  initialWithdraw,
  runWithdraw,
  withdrawReducer,
  type WithdrawDeps,
  type WithdrawEvent,
  type WithdrawState,
} from "./flow"

const wallet = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin"
const receipt: Receipt = {
  request_id: "a".repeat(64),
  signature: "MockSignature1".padEnd(44, "1"),
  slot: 1,
  status: "finalized",
}
const prepared = (level: "none" | "near" | "exact"): UnwrapPrepared => ({
  request_id: "a".repeat(64),
  transaction: "AQID",
  transaction_version: 1,
  required_signers: [wallet],
  recent_blockhash: "hash",
  last_valid_block_height: 1,
  reveal_risk: { level, matches: [] },
})
const needsAck = () => new ApiError(409, "reveal_risk_not_acknowledged")

function deps(overrides: Partial<WithdrawDeps> = {}): WithdrawDeps {
  return {
    prepare: vi.fn(async () => prepared("none")),
    signAndConfirm: vi.fn(async (_p, confirm) => {
      return confirm("sig")
    }),
    confirm: vi.fn(async () => receipt),
    ...overrides,
  }
}

const input = { wallet, amount: "4200000000", acknowledged: false }

describe("runWithdraw", () => {
  it("asks without the acknowledgement first, and goes straight through at no risk", async () => {
    const d = deps()
    const steps: string[] = []
    const outcome = await runWithdraw(d, {
      ...input,
      onPrepared: (level) => steps.push(`prepared:${level}`),
    })

    expect(d.prepare).toHaveBeenCalledWith({
      wallet,
      amount: "4200000000",
      acknowledge_reveal_risk: false,
    })
    expect(outcome).toEqual({ kind: "done", level: "none", receipt })
    expect(steps).toEqual(["prepared:none"])
    expect(d.confirm).toHaveBeenCalledWith({
      request_id: "a".repeat(64),
      signature: "sig",
    })
  })

  it("turns the first 409 into a question and signs nothing", async () => {
    const d = deps({ prepare: vi.fn().mockRejectedValue(needsAck()) })
    const outcome = await runWithdraw(d, input)

    expect(outcome).toEqual({ kind: "needs-acknowledgement" })
    expect(d.signAndConfirm).not.toHaveBeenCalled()
  })

  it("prepares again with the flag set after the person agrees, and reports the level", async () => {
    const prepare = vi.fn(async () => prepared("exact"))
    const d = deps({ prepare })
    const levels: string[] = []
    const outcome = await runWithdraw(d, {
      ...input,
      acknowledged: true,
      onPrepared: (level) => levels.push(level),
    })

    expect(prepare).toHaveBeenCalledWith({
      wallet,
      amount: "4200000000",
      acknowledge_reveal_risk: true,
    })
    expect(levels).toEqual(["exact"])
    expect(outcome).toMatchObject({ kind: "done", level: "exact" })
  })

  it("does not loop when an acknowledged ask still gets the 409", async () => {
    const d = deps({ prepare: vi.fn().mockRejectedValue(needsAck()) })
    await expect(
      runWithdraw(d, { ...input, acknowledged: true }),
    ).rejects.toMatchObject({ code: "reveal_risk_not_acknowledged" })
    expect(d.prepare).toHaveBeenCalledTimes(1)
  })

  it.each([
    new ApiError(409, "invalid_confidential_state"),
    new ApiError(409, "some_other_conflict"),
    new ApiError(503, "service_unavailable"),
  ])("throws any other prepare failure (%s)", async (error) => {
    const d = deps({ prepare: vi.fn().mockRejectedValue(error) })
    await expect(runWithdraw(d, input)).rejects.toBe(error)
    expect(d.signAndConfirm).not.toHaveBeenCalled()
  })

  it("forwards signing steps and surfaces a failed confirm", async () => {
    const failure = new ApiError(409, "transaction_failed")
    const d = deps({
      signAndConfirm: vi.fn(async (_p, _c, onStep) => {
        onStep("signing")
        onStep("submitting")
        throw failure
      }),
    })
    const steps: string[] = []
    await expect(
      runWithdraw(d, { ...input, onStep: (step) => steps.push(step) }),
    ).rejects.toBe(failure)
    expect(steps).toEqual(["signing", "submitting"])
  })
})

describe("withdrawReducer", () => {
  const run = (events: WithdrawEvent[], from = initialWithdraw) =>
    events.reduce(withdrawReducer, from)
  const submitted = (amount = "100") => run([{ type: "submit", amount }])
  const asking = (amount = "100") =>
    run([{ type: "needs-acknowledgement" }], submitted(amount))

  it("starts without an agreement", () => {
    expect(submitted()).toMatchObject({
      stage: "working",
      acknowledged: false,
      phase: "preparing",
      level: null,
    })
  })

  it("asks the question after a 409, unticked", () => {
    expect(asking()).toEqual({
      stage: "needs-acknowledgement",
      amount: "100",
      acknowledged: false,
    })
  })

  it("will not send until the box is ticked", () => {
    const state = asking()
    expect(withdrawReducer(state, { type: "submit", amount: "100" })).toBe(
      state,
    )
  })

  it("sends with the agreement once it is ticked", () => {
    const ticked = withdrawReducer(asking(), {
      type: "acknowledge",
      value: true,
    })
    expect(withdrawReducer(ticked, { type: "submit", amount: "100" })).toEqual(
      expect.objectContaining({ stage: "working", acknowledged: true }),
    )
  })

  it("lets the box be unticked again", () => {
    const state = run(
      [
        { type: "acknowledge", value: true },
        { type: "acknowledge", value: false },
      ],
      asking(),
    )
    expect(state).toMatchObject({ acknowledged: false })
  })

  it("takes the agreement back when the amount changes", () => {
    const ticked = withdrawReducer(asking(), {
      type: "acknowledge",
      value: true,
    })
    const edited = withdrawReducer(ticked, { type: "amount-changed" })
    expect(edited).toEqual(initialWithdraw)
    // The next send asks without the flag again.
    expect(withdrawReducer(edited, { type: "submit", amount: "200" })).toEqual(
      expect.objectContaining({ stage: "working", acknowledged: false }),
    )
  })

  it("will not send an agreement given for another amount", () => {
    const ticked = withdrawReducer(asking("100"), {
      type: "acknowledge",
      value: true,
    })
    expect(withdrawReducer(ticked, { type: "submit", amount: "200" })).toBe(
      ticked,
    )
  })

  it("ignores a tick when nothing is being asked", () => {
    expect(
      withdrawReducer(initialWithdraw, { type: "acknowledge", value: true }),
    ).toBe(initialWithdraw)
    const working = submitted()
    expect(withdrawReducer(working, { type: "acknowledge", value: true })).toBe(
      working,
    )
  })

  it("keeps the level and follows the signing steps to done", () => {
    const state = run([
      { type: "submit", amount: "100" },
      { type: "prepared", level: "near" },
      { type: "step", step: "submitting" },
      { type: "step", step: "confirming" },
    ])
    expect(state).toMatchObject({
      stage: "working",
      phase: "confirming",
      level: "near",
    })
    expect(
      withdrawReducer(state, {
        type: "succeeded",
        level: "near",
        signature: "sig",
      }),
    ).toEqual({
      stage: "done",
      amount: "100",
      level: "near",
      signature: "sig",
    })
  })

  it("does not send twice while working", () => {
    const working = submitted()
    expect(withdrawReducer(working, { type: "submit", amount: "100" })).toBe(
      working,
    )
  })

  const failure = { message: "no", retryable: true, refreshBalance: false }

  it("keeps an agreed amount agreed across a failed attempt, and no other", () => {
    const failed = run(
      [{ type: "failed", failure }],
      run(
        [
          { type: "acknowledge", value: true },
          { type: "submit", amount: "100" },
        ],
        asking(),
      ),
    )
    expect(failed).toMatchObject({ stage: "failed", acknowledged: true })
    expect(withdrawReducer(failed, { type: "submit", amount: "100" })).toEqual(
      expect.objectContaining({ stage: "working", acknowledged: true }),
    )
    expect(withdrawReducer(failed, { type: "submit", amount: "101" })).toEqual(
      expect.objectContaining({ stage: "working", acknowledged: false }),
    )
  })

  it("clears a failure when the amount is edited", () => {
    const failed = run([{ type: "failed", failure }], submitted())
    expect(withdrawReducer(failed, { type: "amount-changed" })).toEqual(
      initialWithdraw,
    )
  })

  it("ignores late events once the withdrawal is over", () => {
    const done: WithdrawState = {
      stage: "done",
      amount: "100",
      level: "none",
      signature: "sig",
    }
    for (const event of [
      { type: "step", step: "signing" },
      { type: "failed", failure },
      { type: "amount-changed" },
      { type: "submit", amount: "100" },
    ] satisfies WithdrawEvent[]) {
      expect(withdrawReducer(done, event)).toBe(done)
    }
    expect(withdrawReducer(done, { type: "reset" })).toEqual(initialWithdraw)
  })
})

describe("failureOf", () => {
  it("shows the contract's words for an API error, and offers a retry for a busy service", () => {
    expect(failureOf(new ApiError(503, "service_unavailable"))).toMatchObject({
      message: "Cadence is unavailable right now. Try again shortly.",
      retryable: true,
    })
    expect(failureOf(new ApiError(429, "rate_limited"))).toMatchObject({
      retryable: true,
    })
  })

  it("treats insufficient balance as stale: no retry, and the balance is read again", () => {
    expect(failureOf(new ApiError(409, "invalid_confidential_state"))).toEqual({
      message: "The account balance changed. Refresh and try again.",
      retryable: false,
      refreshBalance: true,
    })
  })

  it("does not offer a retry for a rejected transaction", () => {
    expect(failureOf(new ApiError(409, "transaction_failed"))).toMatchObject({
      retryable: false,
      refreshBalance: false,
    })
  })

  it("never offers to withdraw again after the transaction was sent", () => {
    expect(failureOf(new ConfirmTimeoutError("sig"))).toMatchObject({
      retryable: false,
      refreshBalance: true,
      message: expect.stringContaining("hasn't confirmed"),
    })
  })

  it("does not leak a raw error message", () => {
    const text = failureOf(new Error("TypeError: secret detail 42")).message
    expect(text).toBe("Something went wrong. Try again.")
    expect(
      failureOf(new WalletUnavailableError("because")).message,
    ).not.toMatch(/because/)
    expect(failureOf(new UnexpectedSignerError()).retryable).toBe(false)
  })
})
