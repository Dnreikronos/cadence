import { describe, expect, it, vi } from "vitest"
import { ApiError, ContractError } from "@/lib/api/errors"
import type { Receipt, UnwrapPrepared } from "@/lib/api/schemas"
import {
  ConfirmTimeoutError,
  UnexpectedSignerError,
  signAndConfirm,
} from "@/lib/api/sign"
import { RunInputUnavailableError } from "@/lib/runs/errors"
import { WalletUnavailableError } from "@/lib/wallet/types"
import {
  SentWithdrawalError,
  failureOf,
  heldBy,
  heldDetail,
  initialWithdraw,
  mergeHeld,
  runWithdraw,
  sentMessage,
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
    signAndConfirm: vi.fn(async (_p, confirm, _onStep, onSubmitted) => {
      onSubmitted("sig")
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

  it("forwards signing steps and passes on a transaction the network rejected as it is", async () => {
    const failure = new ApiError(409, "transaction_failed")
    const d = deps({
      signAndConfirm: vi.fn(async (_p, _c, onStep) => {
        onStep("signing")
        onStep("submitting")
        onStep("confirming")
        throw failure
      }),
    })
    const steps: string[] = []
    await expect(
      runWithdraw(d, { ...input, onStep: (step) => steps.push(step) }),
    ).rejects.toBe(failure)
    expect(steps).toEqual(["signing", "submitting", "confirming"])
  })

  describe("a failure once the transaction may be on the network", () => {
    const failingAt = (
      steps: ("signing" | "submitting" | "confirming")[],
      error: unknown,
      submitted?: string,
    ) =>
      deps({
        signAndConfirm: vi.fn(async (_p, _c, onStep, onSubmitted) => {
          for (const step of steps) onStep(step)
          if (submitted) onSubmitted(submitted)
          throw error
        }),
      })

    it("is a sent withdrawal when submit throws after the broadcast", async () => {
      const d = failingAt(
        ["signing", "submitting"],
        new Error("socket hang up"),
      )
      const thrown = await runWithdraw(d, input).catch((e: unknown) => e)
      expect(thrown).toBeInstanceOf(SentWithdrawalError)
      expect(failureOf(thrown)).toMatchObject({
        sent: true,
        retryable: false,
        message: sentMessage,
        signature: null,
      })
    })

    it("is a sent withdrawal when the confirm answer cannot be read, and keeps the signature", async () => {
      const d = failingAt(
        ["signing", "submitting", "confirming"],
        new ContractError("/unwrap/confirm", "bad shape"),
        "sig",
      )
      const thrown = await runWithdraw(d, input).catch((e: unknown) => e)
      expect(thrown).toBeInstanceOf(SentWithdrawalError)
      expect(failureOf(thrown)).toMatchObject({
        sent: true,
        retryable: false,
        signature: "sig",
      })
    })

    it("is a sent withdrawal on a timeout, with the signature to look up", async () => {
      const d = failingAt(
        ["signing", "submitting", "confirming"],
        new ConfirmTimeoutError("timed-out-sig"),
        "timed-out-sig",
      )
      const thrown = await runWithdraw(d, input).catch((e: unknown) => e)
      expect(failureOf(thrown)).toMatchObject({
        sent: true,
        retryable: false,
        refreshBalance: true,
        signature: "timed-out-sig",
      })
    })

    it("is a sent withdrawal on a busy service while confirming", async () => {
      const d = failingAt(
        ["signing", "submitting", "confirming"],
        new ApiError(503, "service_unavailable"),
      )
      const thrown = await runWithdraw(d, input).catch((e: unknown) => e)
      // Retryable for any other call, but never for a withdrawal that may be out.
      expect(failureOf(thrown)).toMatchObject({ sent: true, retryable: false })
    })

    it("is not sent when it fails while signing", async () => {
      const error = new Error("signer crashed")
      const d = failingAt(["signing"], error)
      await expect(runWithdraw(d, input)).rejects.toBe(error)
    })
  })

  it("sends nothing and offers a retry when the person cancels the signature", async () => {
    const submit = vi.fn(async () => "sig")
    const confirm = vi.fn(async () => receipt)
    const rejecting = Object.assign(new Error("User rejected the request"), {
      name: "UserRejectedRequestError",
      code: 4001,
    })
    const d: WithdrawDeps = {
      prepare: async () => prepared("none"),
      confirm,
      signAndConfirm: (p, c, onStep, onSubmitted) =>
        signAndConfirm(p, {
          signer: {
            address: wallet,
            signTransaction: async () => {
              throw rejecting
            },
          },
          submit,
          confirm: c,
          onStep,
          onSubmitted,
        }),
    }

    const thrown = await runWithdraw(d, input).catch((e: unknown) => e)

    expect(thrown).toBe(rejecting)
    expect(failureOf(thrown)).toEqual({
      message: "You cancelled the signature. Nothing was sent.",
      retryable: true,
      refreshBalance: false,
      sent: false,
      signature: null,
    })
    expect(submit).not.toHaveBeenCalled()
    expect(confirm).not.toHaveBeenCalled()
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
      held: [],
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
      held: [],
    })
  })

  it("does not send twice while working", () => {
    const working = submitted()
    expect(withdrawReducer(working, { type: "submit", amount: "100" })).toBe(
      working,
    )
  })

  const failure = {
    message: "no",
    retryable: true,
    refreshBalance: false,
    sent: false,
    signature: null,
  }

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

  describe("a withdrawal that may already have gone through", () => {
    const sent = {
      message: sentMessage,
      retryable: true, // even if a failure said so, the reducer overrules it
      refreshBalance: true,
      sent: true,
      signature: "sig",
    }
    const failedSent = (amount = "100") =>
      run([{ type: "failed", failure: sent }], submitted(amount))

    it("is never retryable, and holds the amount with its signature", () => {
      expect(failedSent()).toMatchObject({
        stage: "failed",
        failure: { sent: true, retryable: false },
        held: [{ amount: "100", signature: "sig" }],
      })
    })

    it("refuses the same amount again, and allows another", () => {
      const state = failedSent()
      expect(withdrawReducer(state, { type: "submit", amount: "100" })).toBe(
        state,
      )
      expect(withdrawReducer(state, { type: "submit", amount: "101" })).toEqual(
        expect.objectContaining({ stage: "working", amount: "101" }),
      )
    })

    it("still refuses it after the field is edited and typed back", () => {
      const edited = withdrawReducer(failedSent(), { type: "amount-changed" })
      expect(edited).toMatchObject({
        stage: "form",
        held: [{ amount: "100" }],
      })
      expect(withdrawReducer(edited, { type: "submit", amount: "100" })).toBe(
        edited,
      )
      expect(
        withdrawReducer(edited, { type: "submit", amount: "100.5" }),
      ).toEqual(expect.objectContaining({ stage: "working" }))
    })

    it("keeps holding it through another amount's withdrawal", () => {
      const done = run(
        [
          { type: "submit", amount: "200" },
          { type: "succeeded", level: "none", signature: "other" },
          { type: "reset" },
        ],
        failedSent(),
      )
      expect(done).toMatchObject({ stage: "form", held: [{ amount: "100" }] })
      expect(withdrawReducer(done, { type: "submit", amount: "100" })).toBe(
        done,
      )
    })

    it("holds every unresolved amount, so an earlier one is not freed by a later one", () => {
      const both = run(
        [
          { type: "submit", amount: "100" },
          { type: "failed", failure: { ...sent, signature: "sigY" } },
          { type: "amount-changed" },
        ],
        withdrawReducer(failedSent("200"), { type: "amount-changed" }),
      )
      // 200 is unresolved, then 100 is submitted and unresolved too.
      expect(both).toMatchObject({
        stage: "form",
        held: [{ amount: "200" }, { amount: "100", signature: "sigY" }],
      })
      expect(withdrawReducer(both, { type: "submit", amount: "200" })).toBe(
        both,
      )
      expect(withdrawReducer(both, { type: "submit", amount: "100" })).toBe(
        both,
      )
      expect(withdrawReducer(both, { type: "submit", amount: "300" })).toEqual(
        expect.objectContaining({ stage: "working" }),
      )
    })

    it("takes in what the mutation cache holds without losing what it already has", () => {
      const state = run(
        [
          {
            type: "hold",
            held: [
              { amount: "200", signature: "a" },
              { amount: "300", signature: null },
            ],
          },
        ],
        failedSent("100"),
      )
      expect(state.held.map((h) => h.amount)).toEqual(["100", "200", "300"])
      // Holding the same things again changes nothing.
      expect(withdrawReducer(state, { type: "hold", held: state.held })).toBe(
        state,
      )
    })

    it("takes the kept list as it is, so a withdrawal a lookup settled is released", () => {
      const state = run(
        [
          {
            type: "sync-held",
            held: [
              { amount: "100", signature: "a" },
              { amount: "200", signature: null },
            ],
          },
        ],
        failedSent("300"),
      )
      expect(state.held.map((h) => h.amount)).toEqual(["100", "200"])
      expect(
        withdrawReducer(state, { type: "submit", amount: "300" }).stage,
      ).toBe("working")
      expect(withdrawReducer(state, { type: "submit", amount: "100" })).toBe(
        state,
      )
      // The same list again changes nothing.
      expect(
        withdrawReducer(state, {
          type: "sync-held",
          held: state.held.map((h) => ({ ...h })),
        }),
      ).toBe(state)
    })

    it("does not hold anything for an ordinary failure", () => {
      const state = run([{ type: "failed", failure }], submitted())
      expect(state.held).toEqual([])
      expect(withdrawReducer(state, { type: "submit", amount: "100" })).toEqual(
        expect.objectContaining({ stage: "working" }),
      )
    })
  })

  it("ignores late events once the withdrawal is over", () => {
    const done: WithdrawState = {
      stage: "done",
      amount: "100",
      level: "none",
      signature: "sig",
      held: [],
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

describe("heldDetail", () => {
  const held = { amount: "100", signature: "sig" }
  const failedFor = (amount: string, sent: boolean): WithdrawState => ({
    stage: "failed",
    amount,
    acknowledged: false,
    failure: {
      message: "x",
      retryable: !sent,
      refreshBalance: false,
      sent,
      signature: null,
    },
    held: [held],
  })

  it("shows it in full at rest, and while asking to agree", () => {
    expect(heldDetail({ ...initialWithdraw, held: [held] }, held)).toBe("full")
    expect(
      heldDetail(
        {
          stage: "needs-acknowledgement",
          amount: "200",
          acknowledged: false,
          held: [held],
        },
        held,
      ),
    ).toBe("full")
  })

  it("shrinks it to a line while another amount is being sent", () => {
    expect(
      heldDetail(
        withdrawReducer(
          { ...initialWithdraw, held: [held] },
          { type: "submit", amount: "200" },
        ),
        held,
      ),
    ).toBe("summary")
  })

  it("shrinks it when another amount failed for good, but not when it is the one that failed", () => {
    expect(heldDetail(failedFor("200", false), held)).toBe("summary")
    expect(heldDetail(failedFor("100", true), held)).toBe("full")
    // Another amount may also have gone out: the earlier one is not the news.
    expect(heldDetail(failedFor("200", true), held)).toBe("summary")
  })
})

describe("mergeHeld", () => {
  it("keeps one entry per amount, and prefers a known signature", () => {
    const merged = mergeHeld(
      [{ amount: "1", signature: null }],
      [
        { amount: "1", signature: "s1" },
        { amount: "2", signature: null },
        { amount: "2", signature: "s2" },
      ],
    )
    expect(merged).toEqual([
      { amount: "1", signature: "s1" },
      { amount: "2", signature: "s2" },
    ])
  })

  it("returns the very same list when nothing is new", () => {
    const current = [{ amount: "1", signature: "s" }]
    expect(mergeHeld(current, [{ amount: "1", signature: null }])).toBe(current)
  })
})

describe("heldBy", () => {
  it("holds the amount of a withdrawal that may have gone out, with its signature", () => {
    expect(
      heldBy(new SentWithdrawalError(new Error("x"), "sig"), "100"),
    ).toEqual({ amount: "100", signature: "sig" })
    expect(heldBy(new ConfirmTimeoutError("t"), "5")).toEqual({
      amount: "5",
      signature: "t",
    })
  })

  it("holds nothing for a failure that sent nothing, or without an amount", () => {
    expect(heldBy(new ApiError(503, "service_unavailable"), "100")).toBeNull()
    expect(heldBy(new ApiError(409, "transaction_failed"), "100")).toBeNull()
    expect(
      heldBy(new SentWithdrawalError(new Error("x"), null), undefined),
    ).toBeNull()
  })

  it("is what a screen opened later is given, so the amount stays blocked", () => {
    const held = heldBy(new SentWithdrawalError(new Error("x"), "sig"), "100")!
    const reopened = withdrawReducer(initialWithdraw, {
      type: "hold",
      held: [held],
    })
    expect(withdrawReducer(reopened, { type: "submit", amount: "100" })).toBe(
      reopened,
    )
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
      sent: false,
      signature: null,
    })
  })

  it("does not offer a retry for a rejected transaction", () => {
    expect(failureOf(new ApiError(409, "transaction_failed"))).toMatchObject({
      retryable: false,
      refreshBalance: false,
    })
  })

  it("never offers to withdraw again after the transaction was sent", () => {
    expect(failureOf(new ConfirmTimeoutError("sig"))).toEqual({
      retryable: false,
      refreshBalance: true,
      sent: true,
      signature: "sig",
      message: expect.stringContaining("may already have gone through"),
    })
  })

  it("does not offer a retry for an answer it cannot read", () => {
    expect(failureOf(new ContractError("/unwrap", "bad shape"))).toMatchObject({
      retryable: false,
      sent: false,
    })
  })

  it("reads a cancelled signature from the usual signs", () => {
    for (const error of [
      Object.assign(new Error("x"), { name: "NotAllowedError" }),
      Object.assign(new Error("x"), { code: 4001 }),
      Object.assign(new Error("x"), { name: "SignatureRejectedError" }),
    ]) {
      expect(failureOf(error)).toMatchObject({
        message: "You cancelled the signature. Nothing was sent.",
        retryable: true,
      })
    }
    expect(failureOf(new Error("x")).message).not.toMatch(/cancelled/)
  })

  it("does not leak a raw error message", () => {
    const text = failureOf(new Error("TypeError: secret detail 42")).message
    expect(text).toBe("Something went wrong. Try again.")
    expect(
      failureOf(new WalletUnavailableError("because")).message,
    ).not.toMatch(/because/)
    expect(failureOf(new UnexpectedSignerError()).retryable).toBe(false)
  })

  it("says a withdrawal cannot be made here yet when its keys are refused, with no retry", () => {
    expect(failureOf(new RunInputUnavailableError("balance key"))).toEqual({
      message: "Withdrawals aren't available in this environment yet.",
      retryable: false,
      refreshBalance: false,
      sent: false,
      signature: null,
    })
  })
})
