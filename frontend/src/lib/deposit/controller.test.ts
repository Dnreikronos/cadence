import { describe, expect, it, vi } from "vitest"
import { base64FromBytes } from "@/lib/api/base64"
import { ApiError } from "@/lib/api/errors"
import { mockAccountTransaction } from "@/lib/api/mocks/chain"
import { COMPANY_WALLET } from "@/lib/api/mocks/db"
import { mockSigner } from "@/lib/api/mocks/signer"
import type { Receipt } from "@/lib/api/schemas"
import type { Submission } from "@/lib/submissions"
import { bindSignAndConfirm } from "@/lib/wallet/sign-and-confirm"
import type { Wallet } from "@/lib/wallet/types"
import {
  MakePrivateController,
  describeUsdc,
  type Deps,
  type MakePrivateState,
} from "./controller"
import { ConfirmTimeoutError } from "@/lib/api/sign"
import { browserProfile } from "@/lib/browser-profile"
import type { Acquired } from "@/lib/flow-lock"
import { submissionStore } from "@/lib/submissions"
import {
  StorageUnavailableError,
  storageBlockedMessage,
} from "@/lib/storage-guard"

const SIG = "5SigMockSignature1111111111111111111111111111"
const receipt = (id: string): Receipt => ({
  request_id: id.repeat(64).slice(0, 64),
  signature: SIG,
  slot: 1,
  status: "finalized",
})
const prepared = (id: string) => ({
  request_id: id.repeat(64).slice(0, 64),
  // Bytes the pre-sign check reads as the wallet's own wrap.
  transaction: base64FromBytes(
    mockAccountTransaction({ kind: "wrap", wallet: COMPANY_WALLET, n: 1 }),
  ),
  transaction_version: 0 as const,
  required_signers: [COMPANY_WALLET],
  recent_blockhash: "blockhash",
  last_valid_block_height: 500,
})
const chainHeight = (clock: number) =>
  400 + Math.floor((clock - 1_000_000) / 400)

// Resolves when released; rejects with the abort reason when the signal fires,
// like a fetch that is cancelled.
function gate() {
  let release!: () => void
  const open = new Promise<void>((resolve) => (release = resolve))
  const wait = (signal?: AbortSignal) =>
    new Promise<void>((resolve, reject) => {
      void open.then(resolve)
      signal?.addEventListener("abort", () => reject(signal.reason), {
        once: true,
      })
    })
  return { release, wait }
}

function setup(
  options: {
    saved?: Submission | null
    wallet?: Partial<Wallet>
    storage?: "available" | "unavailable"
    pendingUnits?: string | null
    signAndConfirm?: Deps["signAndConfirm"]
    requireStorage?: Deps["requireStorage"]
    lock?: Deps["lock"]
    // A store shared with other screens, in place of this one's own.
    sharedStore?: Deps["store"]
  } = {},
) {
  let saved = options.saved ?? null
  let clock = 1_000_000
  const records: Submission[] = []
  const unavailable = options.storage === "unavailable"
  const store: Deps["store"] = options.sharedStore ?? {
    read: () => (unavailable ? null : saved),
    record: (record) => {
      const full = { ...record, at: record.at ?? clock }
      records.push(full)
      if (!unavailable) saved = full
      return full
    },
    clear: () => {
      saved = null
    },
  }
  const api = {
    wrap: {
      prepare: vi.fn(async () => ({
        ...prepared("a"),
        destination: "dest",
        mint: "mint",
        deposit_state: "pending_after_confirmation" as const,
      })),
      confirm: vi.fn<(...args: unknown[]) => Promise<Receipt>>(async () =>
        receipt("a"),
      ),
    },
    accounts: {
      applyPending: vi.fn(async () => prepared("b")),
      confirmApplyPending: vi.fn<(...args: unknown[]) => Promise<Receipt>>(
        async () => receipt("b"),
      ),
    },
  }
  const wallet: Wallet = {
    status: "ready",
    loading: false,
    address: COMPANY_WALLET,
    signer: mockSigner(COMPANY_WALLET),
    submit: vi.fn(async () => SIG),
    finality: vi.fn(async () => "finalized" as const),
    ...options.wallet,
  }
  const refresh = vi.fn()
  const toast = vi.fn()
  const sleep = vi.fn(async (ms: number) => {
    clock += ms
  })
  const deps: Deps = {
    wallet: COMPANY_WALLET,
    api: api as never,
    signAndConfirm: options.signAndConfirm ?? bindSignAndConfirm(wallet),
    refresh,
    toast,
    store,
    requireStorage: options.requireStorage,
    lock: options.lock,
    // Not given: the balance was read and nothing was pending. `null`: not known.
    pendingUnits: () =>
      options.pendingUnits === null ? undefined : (options.pendingUnits ?? "0"),
    now: () => clock,
    // A block every 400 ms on the same clock, 100 blocks (40 s) short of the
    // prepared transactions' last valid one.
    blockHeight: async () => chainHeight(clock),
    sleep,
  }
  const controller = new MakePrivateController(() => deps)
  const seen: string[] = []
  controller.subscribe(() => {
    const s = controller.getState()
    seen.push(s.status === "running" ? `running:${s.step}` : s.status)
  })
  return {
    controller,
    api,
    wallet,
    refresh,
    toast,
    sleep,
    store,
    records,
    seen,
    saved: () => saved,
    advance: (ms: number) => (clock += ms),
    // A second screen on the same storage, as after leaving and coming back.
    revisit: () => new MakePrivateController(() => deps),
  }
}

// The state as the tests read it, narrowed.
function failed(state: MakePrivateState) {
  expect(state.status).toBe("failed")
  return state as Extract<MakePrivateState, { status: "failed" }>
}

describe("describeUsdc", () => {
  it("is exact, so one base unit is not $0.00", () => {
    expect(describeUsdc("2500000000")).toBe("2500 USDC")
    expect(describeUsdc("1")).toBe("0.000001 USDC")
  })
})

describe("MakePrivateController without a way to keep a record", () => {
  const blocked = () => {
    throw new StorageUnavailableError()
  }

  it("refuses to start in real mode: nothing is prepared, signed or sent", async () => {
    const { controller, api, wallet } = setup({ requireStorage: blocked })
    await controller.deposit("1000000")
    const state = failed(controller.getState())
    expect(state.message).toBe(storageBlockedMessage)
    expect(state.retryable).toBe(true)
    expect(api.wrap.prepare).not.toHaveBeenCalled()
    expect(wallet.submit).not.toHaveBeenCalled()
  })

  it("stops the wrap before the send when the record cannot be kept once it is made", async () => {
    let calls = 0
    const { controller, wallet, saved } = setup({
      requireStorage: () => {
        // The start passes; the check right after the record is written does not.
        if (++calls > 1) blocked()
      },
    })
    await controller.deposit("1000000")
    const state = failed(controller.getState())
    expect(state.message).toBe(storageBlockedMessage)
    expect(wallet.submit).not.toHaveBeenCalled()
    // Not "may have been sent": a retry is the way on, once storage works.
    expect(state.resume).toBe("wrap")
    expect(state.recheck).toBe(false)
    void saved
  })

  it("goes on when the check passes", async () => {
    const requireStorage = vi.fn()
    const { controller, wallet } = setup({ requireStorage })
    await controller.deposit("1000000")
    expect(controller.getState().status).toBe("done")
    expect(requireStorage).toHaveBeenCalled()
    expect(wallet.submit).toHaveBeenCalled()
  })
})

describe("MakePrivateController", () => {
  it("walks the steps in order and ends done, with the record cleared", async () => {
    const { controller, seen, toast, refresh, saved, api } = setup()

    await controller.deposit("2500000000")

    expect(seen).toEqual([
      "running:preparing",
      "running:signing",
      "running:confirming",
      "running:applying",
      "done",
    ])
    expect(controller.getState()).toEqual({
      status: "done",
      amount: "2500000000",
    })
    expect(toast).toHaveBeenCalledWith("Your deposit is now private")
    // One refresh per confirmed transaction, so the sidebar follows each.
    expect(refresh).toHaveBeenCalledTimes(2)
    expect(saved()).toBeNull()
    expect(api.wrap.prepare).toHaveBeenCalledTimes(1)
  })

  it("records the wrap before submit, then its signature, and clears both once confirmed", async () => {
    const { controller, records, wallet, saved } = setup()
    const order: string[] = []
    vi.mocked(wallet.submit).mockImplementation(async () => {
      order.push(`submit with ${records.length} record(s)`)
      return SIG
    })

    await controller.deposit("1000000")

    // The first submit is the wrap's: its record is already saved, unsigned.
    expect(order[0]).toBe("submit with 1 record(s)")
    expect(records).toHaveLength(2)
    expect(records[0]).toMatchObject({
      kind: "wrap",
      request_id: prepared("a").request_id,
      signature: null,
      last_valid_block_height: 500,
      wallet: COMPANY_WALLET,
    })
    expect(records[1]).toMatchObject({ signature: SIG, at: records[0].at })
    expect(saved()).toBeNull()
  })

  describe("a second click", () => {
    it("is ignored while the first is running: one wrap, not two", async () => {
      const { controller, api } = setup()

      const first = controller.deposit("1000000")
      const second = controller.deposit("1000000")
      await first
      await second

      expect(api.wrap.prepare).toHaveBeenCalledTimes(1)
    })

    it("is ignored while an earlier deposit is being checked", async () => {
      const first = setup()
      const gated = gate()
      first.api.wrap.confirm.mockImplementation(async (...args) => {
        await gated.wait((args[1] as { signal?: AbortSignal }).signal)
        return receipt("a")
      })
      const run = first.controller.deposit("1000000")
      await vi.waitFor(() => expect(first.saved()?.signature).toBe(SIG))
      first.controller.dispose()
      await run

      const back = first.revisit()
      expect(back.getState().status).toBe("checking")
      await back.deposit("1000000")

      expect(first.api.wrap.prepare).toHaveBeenCalledTimes(1)
      expect(back.getState().status).toBe("checking")
    })
  })

  describe("leaving mid-run", () => {
    it("stops before the apply, says nothing, and keeps the record of a wrap already sent", async () => {
      const { controller, api, toast, refresh, saved, seen } = setup()
      const gated = gate()
      api.wrap.confirm.mockImplementation(async (...args) => {
        await gated.wait((args[1] as { signal?: AbortSignal }).signal)
        return receipt("a")
      })
      const run = controller.deposit("1000000")
      await vi.waitFor(() => expect(saved()?.signature).toBe(SIG))
      const before = [...seen]

      controller.dispose()
      gated.release()
      await run

      expect(api.accounts.applyPending).not.toHaveBeenCalled()
      expect(toast).not.toHaveBeenCalled()
      expect(refresh).not.toHaveBeenCalled()
      expect(seen).toEqual(before)
      expect(saved()).toMatchObject({ signature: SIG })
    })

    it("sends nothing and records nothing when it happens while signing", async () => {
      const gated = gate()
      const setupResult = setup({
        wallet: {
          signer: {
            address: COMPANY_WALLET,
            signTransaction: async (bytes) => {
              await gated.wait()
              return bytes
            },
          },
        },
      })
      const { controller, wallet, api, saved } = setupResult
      const run = controller.deposit("1000000")
      await vi.waitFor(() =>
        expect(controller.getState()).toEqual({
          status: "running",
          step: "signing",
        }),
      )

      controller.dispose()
      gated.release()
      await run

      expect(wallet.submit).not.toHaveBeenCalled()
      expect(api.wrap.confirm).not.toHaveBeenCalled()
      expect(saved()).toBeNull()
    })
  })

  describe("coming back after leaving", () => {
    async function leaveAfterSubmit() {
      const harness = setup()
      const gated = gate()
      harness.api.wrap.confirm.mockImplementation(async (...args) => {
        await gated.wait((args[1] as { signal?: AbortSignal }).signal)
        return receipt("a")
      })
      const run = harness.controller.deposit("1000000")
      await vi.waitFor(() => expect(harness.saved()?.signature).toBe(SIG))
      harness.controller.dispose()
      await run
      harness.api.wrap.confirm.mockReset()
      return harness
    }

    it("finds the record and holds the form until the wrap is confirmed", async () => {
      const harness = await leaveAfterSubmit()
      harness.api.wrap.confirm.mockResolvedValue(receipt("a"))
      const back = harness.revisit()
      expect(back.getState()).toEqual({ status: "checking" })
      expect(back.inFlight).toBe(true)

      back.start()
      await vi.waitFor(() =>
        expect(back.getState().status).not.toBe("checking"),
      )

      expect(back.getState()).toEqual({
        status: "resolved",
        outcome: "confirmed",
      })
      expect(harness.api.wrap.confirm).toHaveBeenCalledWith(
        { request_id: prepared("a").request_id, signature: SIG },
        expect.anything(),
      )
      expect(harness.saved()).toBeNull()
      expect(harness.refresh).toHaveBeenCalled()
      expect(back.inFlight).toBe(false)
    })

    it("reports a failed wrap and clears the record, so depositing again is allowed", async () => {
      const harness = await leaveAfterSubmit()
      harness.api.wrap.confirm.mockRejectedValue(
        new ApiError(409, "transaction_failed"),
      )
      const back = harness.revisit()

      back.start()
      await vi.waitFor(() => expect(back.getState().status).toBe("resolved"))

      expect(back.getState()).toEqual({ status: "resolved", outcome: "failed" })
      expect(harness.saved()).toBeNull()
      await back.deposit("1000000")
      expect(harness.api.wrap.prepare).toHaveBeenCalledTimes(2)
    })

    it("keeps checking while the network has not finalized it, then confirms", async () => {
      const harness = await leaveAfterSubmit()
      harness.api.wrap.confirm
        .mockRejectedValueOnce(new ApiError(409, "transaction_not_finalized"))
        .mockRejectedValueOnce(new ApiError(409, "transaction_not_finalized"))
        .mockResolvedValue(receipt("a"))
      const back = harness.revisit()

      back.start()
      await vi.waitFor(() => expect(back.getState().status).toBe("resolved"))

      expect(back.getState()).toEqual({
        status: "resolved",
        outcome: "confirmed",
      })
      expect(harness.api.wrap.confirm).toHaveBeenCalledTimes(3)
    })

    it("calls a wrap that never showed up failed only once the chain is past its last valid block", async () => {
      const harness = await leaveAfterSubmit()
      harness.api.wrap.confirm.mockRejectedValue(
        new ApiError(409, "transaction_not_finalized"),
      )
      const back = harness.revisit()

      back.start()
      await vi.waitFor(() => expect(back.getState().status).toBe("resolved"))

      expect(back.getState()).toEqual({ status: "resolved", outcome: "failed" })
      const waited = harness.sleep.mock.calls.reduce((sum, [ms]) => sum + ms, 0)
      expect(chainHeight(1_000_000 + waited)).toBeGreaterThan(500)
      expect(chainHeight(1_000_000 + waited - 3_000)).toBeLessThanOrEqual(500)
    })

    it("keeps the lock and the record when the service cannot be asked, and checks again on request", async () => {
      const harness = await leaveAfterSubmit()
      harness.api.wrap.confirm.mockRejectedValue(new TypeError("boom"))
      const back = harness.revisit()

      back.start()
      await vi.waitFor(() => expect(back.getState().status).toBe("failed"))

      expect(failed(back.getState())).toMatchObject({
        resume: "check",
        retryable: false,
      })
      expect(harness.saved()).not.toBeNull()
      await back.deposit("1000000")
      expect(harness.api.wrap.prepare).toHaveBeenCalledTimes(1)

      harness.api.wrap.confirm.mockReset()
      harness.api.wrap.confirm.mockResolvedValue(receipt("a"))
      await back.check()
      expect(back.getState()).toEqual({
        status: "resolved",
        outcome: "confirmed",
      })
      expect(harness.saved()).toBeNull()
    })

    it("survives a strict-mode remount: start, dispose, start resolves once", async () => {
      const harness = await leaveAfterSubmit()
      harness.api.wrap.confirm.mockResolvedValue(receipt("a"))
      const back = harness.revisit()

      back.start()
      back.dispose()
      back.start()
      await vi.waitFor(() => expect(back.getState().status).toBe("resolved"))

      expect(back.getState()).toEqual({
        status: "resolved",
        outcome: "confirmed",
      })
    })

    it("ignores a record that belongs to another wallet", () => {
      const harness = setup({
        saved: {
          kind: "wrap",
          request_id: "c".repeat(64),
          signature: SIG,
          last_valid_block_height: 1,
          wallet: "someone-else",
          at: 1,
        },
      })
      expect(harness.controller.getState()).toEqual({ status: "idle" })
    })
  })

  describe("a failure at each step", () => {
    it("preparing: a busy service can be retried, and the retry works", async () => {
      const { controller, api, saved } = setup()
      api.wrap.prepare.mockRejectedValueOnce(
        new ApiError(429, "wrap_rate_limited", 60),
      )

      await controller.deposit("1000000")
      expect(failed(controller.getState())).toMatchObject({
        step: "preparing",
        resume: "wrap",
        retryable: true,
      })
      expect(saved()).toBeNull()

      await controller.retry()
      expect(controller.getState().status).toBe("done")
      expect(api.wrap.prepare).toHaveBeenCalledTimes(2)
    })

    it("preparing: an account that needs activating gets no retry", async () => {
      const { controller, api } = setup()
      api.wrap.prepare.mockRejectedValue(
        new ApiError(409, "confidential_setup_required"),
      )

      await controller.deposit("1000000")

      expect(failed(controller.getState())).toMatchObject({
        setupRequired: true,
        retryable: false,
      })
    })

    it("signing: a wallet that refuses is retried from the wrap, with nothing recorded", async () => {
      const refuse = vi.fn(async (bytes: Uint8Array) => {
        if (refuse.mock.calls.length === 1) throw new Error("rejected")
        return bytes
      })
      const { controller, saved, api } = setup({
        wallet: {
          signer: { address: COMPANY_WALLET, signTransaction: refuse },
        },
      })

      await controller.deposit("1000000")
      expect(failed(controller.getState())).toMatchObject({
        step: "signing",
        resume: "wrap",
        retryable: true,
      })
      expect(saved()).toBeNull()

      await controller.retry()
      expect(controller.getState().status).toBe("done")
      expect(api.wrap.prepare).toHaveBeenCalledTimes(2)
    })

    it("submitting: a throw after the broadcast is checked, never retried into a second wrap", async () => {
      const { controller, api, saved, advance } = setup({
        wallet: {
          submit: vi.fn(async () => {
            throw new Error("RPC timed out")
          }),
        },
      })

      await controller.deposit("1000000")

      const state = failed(controller.getState())
      expect(state).toMatchObject({ resume: "check", retryable: false })
      // The wrap stays recorded, with no signature, so a reload finds it too.
      expect(saved()).toMatchObject({ signature: null })
      await controller.retry()
      await controller.deposit("1000000")
      expect(api.wrap.prepare).toHaveBeenCalledTimes(1)

      // Asking from here cannot confirm what has no signature: it waits out the
      // blockhash, then says it does not know, and holds: the record stays, and no new
      // wrap is sent until the person releases it.
      await controller.check()
      expect(controller.getState()).toMatchObject({ status: "held" })
      expect(saved()).toMatchObject({ signature: null })
      await controller.deposit("1000000")
      expect(api.wrap.prepare).toHaveBeenCalledTimes(1)
      expect(controller.getState()).toMatchObject({ status: "held" })

      advance(120_000)
      await controller.release()
      expect(controller.getState()).toEqual({ status: "idle" })
      expect(saved()).toBeNull()
      await controller.deposit("1000000")
      expect(api.wrap.prepare).toHaveBeenCalledTimes(2)
    })

    it("confirming: a transaction the network dropped is retried from the wrap and the record is cleared", async () => {
      const { controller, api, saved } = setup()
      api.wrap.confirm.mockRejectedValueOnce(
        new ApiError(409, "transaction_failed"),
      )

      await controller.deposit("1000000")
      expect(failed(controller.getState())).toMatchObject({
        step: "confirming",
        resume: "wrap",
        retryable: true,
      })
      expect(saved()).toBeNull()

      await controller.retry()
      expect(controller.getState().status).toBe("done")
    })

    it("confirming: a 404 is not a failure, so the record is kept and no retry is offered", async () => {
      const { controller, api, saved } = setup()
      api.wrap.confirm.mockRejectedValue(new ApiError(404, "wrap_not_found"))

      await controller.deposit("1000000")

      expect(failed(controller.getState())).toMatchObject({
        step: "confirming",
        resume: "check",
        retryable: false,
      })
      expect(saved()).toMatchObject({ signature: SIG })
    })

    it("applying: resumes at the apply and never wraps twice", async () => {
      const { controller, api, saved } = setup()
      api.accounts.applyPending.mockRejectedValueOnce(
        new ApiError(409, "credit_counter_mismatch"),
      )

      await controller.deposit("1000000")
      expect(failed(controller.getState())).toMatchObject({
        step: "applying",
        resume: "apply",
        retryable: true,
      })
      // The wrap was seen through, so nothing is left to look for.
      expect(saved()).toBeNull()

      await controller.retry()

      expect(controller.getState()).toEqual({
        status: "done",
        amount: "1000000",
      })
      expect(api.wrap.prepare).toHaveBeenCalledTimes(1)
      expect(api.accounts.applyPending).toHaveBeenCalledTimes(2)
    })

    it("applying: an apply that was sent and not confirmed is checked, not retried", async () => {
      let transactions = 0
      const { controller, api, refresh } = setup({
        // The wrap confirms; the apply goes out and the network never answers.
        signAndConfirm: async (_prepared, confirm, onStep, extra) => {
          if (++transactions === 1) {
            onStep?.("signing")
            onStep?.("submitting")
            extra?.onSubmitted?.(SIG)
            onStep?.("confirming")
            return confirm(SIG)
          }
          throw new ConfirmTimeoutError(SIG)
        },
      })

      await controller.deposit("1000000")

      expect(failed(controller.getState())).toMatchObject({
        step: "applying",
        resume: "check",
        retryable: false,
      })
      await controller.retry()
      expect(api.accounts.applyPending).toHaveBeenCalledTimes(1)
      refresh.mockClear()
      // Nothing is recorded for an apply, so looking is just a refresh.
      await controller.check()
      expect(controller.getState()).toEqual({ status: "idle" })
      expect(refresh).toHaveBeenCalledTimes(1)
    })

    describe("an apply that went out and failed with an unreadable answer", () => {
      // The wrap confirms; the apply's confirm answers 500, so it is a sent failure
      // with its signature saved.
      async function sentApply() {
        const harness = setup()
        harness.api.accounts.confirmApplyPending.mockRejectedValue(
          new ApiError(500, "internal_error"),
        )
        await harness.controller.deposit("1000000")
        return harness
      }

      it("offers a check, never a second apply, and the check carries the signature", async () => {
        const { controller, api, wallet } = await sentApply()

        expect(failed(controller.getState())).toMatchObject({
          step: "applying",
          resume: "check",
          retryable: false,
          recheck: true,
        })
        expect(failed(controller.getState()).message).toMatch(
          /may already have gone through/,
        )
        // Nothing starts another apply or another wrap from here.
        await controller.retry()
        await controller.applyPending()
        expect(api.accounts.applyPending).toHaveBeenCalledTimes(1)
        expect(api.wrap.prepare).toHaveBeenCalledTimes(1)
        expect(wallet.submit).toHaveBeenCalledTimes(2)
      })

      it("settles as done when asking again confirms the same transaction", async () => {
        const { controller, api, refresh, toast, seen, wallet } =
          await sentApply()
        api.accounts.confirmApplyPending.mockResolvedValue(receipt("b"))
        refresh.mockClear()

        await controller.checkAgain()

        expect(api.accounts.confirmApplyPending).toHaveBeenLastCalledWith(
          { request_id: prepared("b").request_id, signature: SIG },
          expect.anything(),
        )
        expect(seen.slice(-2)).toEqual(["checking", "done"])
        expect(controller.getState()).toEqual({
          status: "done",
          amount: "1000000",
        })
        expect(toast).toHaveBeenCalledWith("Your deposit is now private")
        expect(refresh).toHaveBeenCalled()
        // Asking prepared and signed nothing.
        expect(api.accounts.applyPending).toHaveBeenCalledTimes(1)
        expect(wallet.submit).toHaveBeenCalledTimes(2)
      })

      it("offers another apply only once the network says the first one failed", async () => {
        const { controller, api } = await sentApply()
        api.accounts.confirmApplyPending.mockRejectedValue(
          new ApiError(409, "transaction_failed"),
        )

        await controller.checkAgain()

        expect(failed(controller.getState())).toMatchObject({
          step: "applying",
          resume: "apply",
          retryable: true,
          recheck: false,
        })
        api.accounts.confirmApplyPending.mockResolvedValue(receipt("b"))
        await controller.retry()
        expect(controller.getState().status).toBe("done")
        expect(api.accounts.applyPending).toHaveBeenCalledTimes(2)
      })

      it("stays a check when the answer is still unclear, and when the service cannot be asked", async () => {
        const { controller, api } = await sentApply()
        api.accounts.confirmApplyPending.mockRejectedValue(
          new ApiError(404, "request_not_found"),
        )

        await controller.checkAgain()

        expect(failed(controller.getState())).toMatchObject({
          resume: "check",
          retryable: false,
          recheck: true,
        })

        api.accounts.confirmApplyPending.mockRejectedValue(
          new TypeError("network down"),
        )
        await controller.checkAgain()

        expect(failed(controller.getState())).toMatchObject({
          resume: "check",
          retryable: false,
          recheck: true,
        })
        await controller.retry()
        expect(api.accounts.applyPending).toHaveBeenCalledTimes(1)
      })

      it("keeps asking while the network has not finalized it, then calls it failed after the blockhash window", async () => {
        const { controller, api } = await sentApply()
        api.accounts.confirmApplyPending.mockRejectedValue(
          new ApiError(409, "transaction_not_finalized"),
        )

        await controller.checkAgain()

        // It was never seen on the chain, and a signed transaction cannot land after its
        // blockhash: another apply may be prepared.
        expect(
          api.accounts.confirmApplyPending.mock.calls.length,
        ).toBeGreaterThan(2)
        expect(failed(controller.getState())).toMatchObject({
          resume: "apply",
          retryable: true,
        })
      })

      it("is forgotten by dismissing, and by checking the balances", async () => {
        const first = await sentApply()
        first.controller.dismiss()
        expect(first.controller.getState()).toEqual({ status: "idle" })
        await first.controller.checkAgain()
        expect(first.api.accounts.confirmApplyPending).toHaveBeenCalledTimes(1)

        const second = await sentApply()
        await second.controller.check()
        expect(second.controller.getState()).toEqual({ status: "idle" })
        await second.controller.checkAgain()
        expect(second.api.accounts.confirmApplyPending).toHaveBeenCalledTimes(1)
      })
    })

    it("an apply whose submit threw has no signature to ask about: only the balances", async () => {
      let submits = 0
      const { controller, api } = setup({
        wallet: {
          submit: vi.fn(async () => {
            if (++submits === 1) return SIG
            throw new Error("RPC timed out after broadcast")
          }),
        },
      })

      await controller.deposit("1000000")

      expect(failed(controller.getState())).toMatchObject({
        step: "applying",
        resume: "check",
        retryable: false,
        recheck: false,
      })
      await controller.checkAgain()
      await controller.retry()
      expect(api.accounts.applyPending).toHaveBeenCalledTimes(1)
      expect(api.accounts.confirmApplyPending).not.toHaveBeenCalled()
    })

    it("a non-flow error still ends in a failed state, not an unhandled rejection", async () => {
      const { controller, api } = setup()
      api.wrap.prepare.mockImplementation(() => {
        throw new TypeError("not a promise")
      })

      await controller.deposit("1000000")

      expect(failed(controller.getState()).message).toBe(
        "Something went wrong. Try again.",
      )
    })
  })

  it("remembers a credit that was already pending, since applying it makes it available too", async () => {
    const { controller, toast } = setup({ pendingUnits: "200000000" })

    await controller.deposit("1000000")

    expect(controller.getState()).toEqual({
      status: "done",
      amount: "1000000",
      earlierPending: "200000000",
    })
    // The toast has no amount; the notice on the page says what it covers.
    expect(toast).toHaveBeenCalledWith("Your deposit is now private")
  })

  it("does not claim an earlier credit when none was pending", async () => {
    const { controller } = setup({ pendingUnits: "0" })
    await controller.deposit("1000000")
    expect(controller.getState()).not.toHaveProperty("earlierPending", "0")
    expect(controller.getState()).toEqual({
      status: "done",
      amount: "1000000",
    })
  })

  it("says so without a number when it was not known what was pending", async () => {
    const { controller, toast } = setup({ pendingUnits: null })
    await controller.deposit("1000000")
    expect(controller.getState()).toEqual({
      status: "done",
      amount: "1000000",
      earlierPending: null,
    })
    expect(toast).toHaveBeenCalledWith("Your deposit is now private")
  })

  it("keeps what was pending in the record, for a deposit picked up after a reload", async () => {
    const { controller, records, saved } = setup({ pendingUnits: "200000000" })
    const run = controller.deposit("1000000")
    await run
    expect(records.length).toBeGreaterThan(0)
    expect(records.every((r) => r.earlier_pending === "200000000")).toBe(true)
    expect(saved()).toBeNull()
  })

  it("records none as 0, and leaves the field out when it is not known", async () => {
    const none = setup({ pendingUnits: "0" })
    await none.controller.deposit("1000000")
    expect(none.records[0].earlier_pending).toBe("0")
    const unknown = setup({ pendingUnits: null })
    await unknown.controller.deposit("1000000")
    expect(unknown.records[0].earlier_pending).toBeUndefined()
  })

  it("carries the recorded amount into what it says after a reload", async () => {
    const saved = {
      kind: "wrap",
      request_id: "a".repeat(64),
      signature: SIG,
      last_valid_block_height: 500,
      wallet: COMPANY_WALLET,
      at: 1_000_000,
      earlier_pending: "200000000",
    }
    const { controller } = setup({ saved })
    await controller.start()
    await vi.waitFor(() =>
      expect(controller.getState().status).toBe("resolved"),
    )
    expect(controller.getState()).toMatchObject({
      status: "resolved",
      earlierPending: "200000000",
    })
    // An older record has no field: not known.
    const older = setup({ saved: { ...saved, earlier_pending: undefined } })
    await older.controller.start()
    await vi.waitFor(() =>
      expect(older.controller.getState().status).toBe("resolved"),
    )
    expect(older.controller.getState()).toMatchObject({ earlierPending: null })
  })

  it("applies a pending credit on its own, leaving no amount in the message", async () => {
    const { controller, api, toast } = setup()

    await controller.applyPending()

    expect(api.wrap.prepare).not.toHaveBeenCalled()
    expect(controller.getState()).toEqual({ status: "done", amount: undefined })
    expect(toast).toHaveBeenCalledWith("Your pending USDC is now available")
  })

  it("runs end to end with no storage, and finds nothing to check on return", async () => {
    const { controller, saved, revisit } = setup({ storage: "unavailable" })

    await controller.deposit("1000000")

    expect(controller.getState().status).toBe("done")
    expect(saved()).toBeNull()
    expect(revisit().getState()).toEqual({ status: "idle" })
  })

  it("only guards against leaving once a wrap has gone out", async () => {
    const { controller, api, saved } = setup()
    expect(controller.inFlight).toBe(false)
    const gated = gate()
    api.wrap.confirm.mockImplementation(async (...args) => {
      await gated.wait((args[1] as { signal?: AbortSignal }).signal)
      return receipt("a")
    })

    const run = controller.deposit("1000000")
    await vi.waitFor(() => expect(saved()?.signature).toBe(SIG))
    expect(controller.inFlight).toBe(true)
    gated.release()
    await run
    expect(controller.inFlight).toBe(false)
  })
})

// One tab at a time: a lock for every run and every look at a saved wrap, and the saved
// wrap itself, which the other tabs of the browser read.
describe("MakePrivateController across tabs", () => {
  // A lock that other tabs hold for `busyFor` asks, then free.
  function lock(busyFor = 0) {
    let asks = 0
    let held = 0
    const releases: string[] = []
    return {
      asks: () => asks,
      held: () => held,
      releases,
      take: async (): Promise<Acquired> => {
        asks++
        if (asks <= busyFor) return { status: "busy" }
        held++
        return {
          status: "held",
          lease: {
            release: () => {
              held--
              releases.push("released")
            },
          },
        }
      },
    }
  }

  const SAVED: Submission = {
    kind: "wrap",
    request_id: prepared("a").request_id,
    signature: SIG,
    last_valid_block_height: 500,
    wallet: COMPANY_WALLET,
    at: 1_000_000,
  }

  it("holds the lock for the whole deposit, wrap and apply, and lets go at the end", async () => {
    const taken = lock()
    const { controller, api } = setup({ lock: taken.take })
    api.accounts.applyPending.mockImplementation(async () => {
      // Still held while the apply is prepared.
      expect(taken.held()).toBe(1)
      return prepared("b")
    })

    await controller.deposit("1000000")

    expect(controller.getState().status).toBe("done")
    expect(taken.asks()).toBe(1)
    expect(taken.held()).toBe(0)
    expect(api.accounts.applyPending).toHaveBeenCalledTimes(1)
  })

  it("lets go of the lock after a failure too", async () => {
    const taken = lock()
    const { controller, api } = setup({ lock: taken.take })
    api.wrap.prepare.mockRejectedValue(new ApiError(503, "service_unavailable"))

    await controller.deposit("1000000")

    expect(controller.getState().status).toBe("failed")
    expect(taken.held()).toBe(0)
  })

  it("sends nothing when another tab holds the lock, and says so", async () => {
    const taken = lock(1)
    const { controller, api, saved, wallet } = setup({ lock: taken.take })

    await controller.deposit("1000000")

    expect(controller.getState()).toEqual({ status: "other-tab" })
    expect(api.wrap.prepare).not.toHaveBeenCalled()
    expect(wallet.submit).not.toHaveBeenCalled()
    expect(saved()).toBeNull()
    // Informational: nothing is locked, and the next try goes through.
    expect(controller.inFlight).toBe(false)
    await controller.deposit("1000000")
    expect(controller.getState().status).toBe("done")
    expect(api.wrap.prepare).toHaveBeenCalledTimes(1)
  })

  it("is a second click only once while it waits for the lock", async () => {
    const taken = lock()
    const { controller, api } = setup({ lock: taken.take })

    const first = controller.deposit("1000000")
    const second = controller.deposit("1000000")
    await first
    await second

    expect(taken.asks()).toBe(1)
    expect(api.wrap.prepare).toHaveBeenCalledTimes(1)
  })

  it("applies a pending credit under the lock too, and is refused without it", async () => {
    const busy = setup({ lock: lock(1).take })
    await busy.controller.applyPending()
    expect(busy.controller.getState()).toEqual({ status: "other-tab" })
    expect(busy.api.accounts.applyPending).not.toHaveBeenCalled()

    const taken = lock()
    const free = setup({ lock: taken.take })
    await free.controller.applyPending()
    expect(free.controller.getState().status).toBe("done")
    expect(taken.asks()).toBe(1)
    expect(taken.held()).toBe(0)
  })

  it("looks into a wrap another tab saved while the lock was being asked for, and sends nothing", async () => {
    const store: { current: () => void } = { current: () => {} }
    const taken = lock()
    const {
      controller,
      api,
      saved,
      store: fake,
    } = setup({
      lock: async () => {
        // The other tab's record lands before this tab's turn.
        store.current()
        return taken.take()
      },
    })
    store.current = () => void fake.record(SAVED)
    expect(saved()).toBeNull()

    await controller.deposit("1000000")
    await vi.waitFor(() =>
      expect(controller.getState().status).toBe("resolved"),
    )

    expect(api.wrap.prepare).not.toHaveBeenCalled()
    expect(api.wrap.confirm).toHaveBeenCalledWith(
      { request_id: SAVED.request_id, signature: SIG },
      expect.anything(),
    )
    expect(saved()).toBeNull()
    expect(taken.held()).toBe(0)
  })

  it("looks into a wrap another tab saved after this screen opened, instead of ignoring the click", async () => {
    const harness = setup()
    expect(harness.controller.getState()).toEqual({ status: "idle" })
    harness.store.record(SAVED)

    await harness.controller.deposit("1000000")

    expect(harness.api.wrap.prepare).not.toHaveBeenCalled()
    expect(harness.controller.getState()).toMatchObject({
      status: "resolved",
      outcome: "confirmed",
    })
  })

  describe("opening a screen with a saved wrap", () => {
    it("waits for the lock another tab holds, shows that it does, then looks", async () => {
      const taken = lock(2)
      const harness = setup({ saved: SAVED, lock: taken.take })
      const states: string[] = []
      harness.controller.subscribe(() => {
        const state = harness.controller.getState()
        states.push(
          state.status === "checking" && state.otherTab
            ? "checking:other-tab"
            : state.status,
        )
      })

      harness.controller.start()
      await vi.waitFor(() =>
        expect(harness.controller.getState().status).toBe("resolved"),
      )

      expect(taken.asks()).toBe(3)
      expect(states).toContain("checking:other-tab")
      // It waited in half-second steps (the clock the tests run on is faked).
      expect(harness.sleep).toHaveBeenCalledWith(500, expect.anything())
      expect(harness.api.wrap.confirm).toHaveBeenCalledTimes(1)
      expect(harness.saved()).toBeNull()
      expect(taken.held()).toBe(0)
    })

    it("finds nothing to look into when the other tab settled it meanwhile", async () => {
      const taken = lock(1)
      const harness = setup({ saved: SAVED, lock: taken.take })
      harness.sleep.mockImplementationOnce(async () => {
        // The tab that had the lock finished and cleared the record.
        harness.store.clear()
      })

      harness.controller.start()
      await vi.waitFor(() =>
        expect(harness.controller.getState().status).toBe("idle"),
      )

      expect(harness.api.wrap.confirm).not.toHaveBeenCalled()
      expect(harness.refresh).toHaveBeenCalled()
      expect(taken.held()).toBe(0)
    })

    it("stops waiting when the screen is left, and lets go of a lock it got after that", async () => {
      let answer: (value: Acquired) => void = () => {}
      const released: string[] = []
      const harness = setup({
        saved: SAVED,
        lock: () => new Promise<Acquired>((resolve) => (answer = resolve)),
      })

      harness.controller.start()
      harness.controller.dispose()
      answer({
        status: "held",
        lease: { release: () => void released.push("released") },
      })
      await vi.waitFor(() => expect(released).toEqual(["released"]))

      expect(harness.api.wrap.confirm).not.toHaveBeenCalled()
    })

    it("lets go of the lock after looking, whatever it found", async () => {
      const taken = lock()
      const harness = setup({ saved: SAVED, lock: taken.take })
      harness.api.wrap.confirm.mockRejectedValue(
        new ApiError(409, "transaction_failed"),
      )

      harness.controller.start()
      await vi.waitFor(() =>
        expect(harness.controller.getState().status).toBe("resolved"),
      )

      expect(taken.held()).toBe(0)
    })

    it("does not need a lock where there is none to take", async () => {
      const harness = setup({ saved: SAVED })

      harness.controller.start()
      await vi.waitFor(() =>
        expect(harness.controller.getState().status).toBe("resolved"),
      )

      expect(harness.api.wrap.confirm).toHaveBeenCalledTimes(1)
    })
  })
})

// A wrap whose outcome cannot be told is held in every tab of the browser, like a
// withdrawal: the record stays, nothing new is sent, and a release anywhere frees them all.
describe("MakePrivateController: an unknown outcome held across tabs", () => {
  const viewer = { company: "Solaris", email: "ana@solaris.test" }
  const SAVED: Submission = {
    kind: "wrap",
    request_id: prepared("a").request_id,
    signature: SIG,
    last_valid_block_height: 500,
    wallet: COMPANY_WALLET,
    at: 1_000_000,
  }

  // Two screens of one browser: the same store, each tab with its own view of it, told of
  // the other's writes, and a controller wired to hear it as the screen does.
  function twoTabs(seed: Submission | null = SAVED) {
    const profile = browserProfile()
    const storeA = submissionStore("wrap", viewer, profile.tab())
    const storeB = submissionStore("wrap", viewer, profile.tab())
    if (seed) storeA.record(seed)
    const a = setup({ sharedStore: storeA })
    const b = setup({ sharedStore: storeB })
    // 404: the service has no record of it, which says nothing about whether it landed.
    for (const tab of [a, b]) {
      tab.api.wrap.confirm.mockRejectedValue(
        new ApiError(404, "wrap_not_found"),
      )
    }
    storeA.subscribe(() => a.controller.storeChanged())
    storeB.subscribe(() => b.controller.storeChanged())
    return { a, b, storeA, storeB }
  }

  const settle = (controller: MakePrivateController, status: string) =>
    vi.waitFor(() => expect(controller.getState().status).toBe(status))

  it("keeps the record, and says so, when the outcome cannot be told", async () => {
    const { a, storeA } = twoTabs()

    a.controller.start()
    await settle(a.controller, "held")

    expect(a.controller.getState()).toMatchObject({
      status: "held",
      at: SAVED.at,
    })
    expect(storeA.read()).toMatchObject({ request_id: SAVED.request_id })
    expect(a.controller.inFlight).toBe(false)
  })

  it("holds the second tab too, which sends nothing", async () => {
    const { a, b } = twoTabs()
    a.controller.start()
    await settle(a.controller, "held")

    b.controller.start()
    await settle(b.controller, "held")
    await b.controller.deposit("1000000")
    await b.controller.applyPending()

    expect(b.api.wrap.prepare).not.toHaveBeenCalled()
    expect(b.wallet.submit).not.toHaveBeenCalled()
    expect(b.controller.getState()).toMatchObject({ status: "held" })
  })

  it("is released in every tab by a release in one", async () => {
    const { a, b, storeB } = twoTabs()
    a.controller.start()
    b.controller.start()
    await settle(a.controller, "held")
    await settle(b.controller, "held")

    a.advance(120_000)
    await a.controller.release()

    expect(a.controller.getState()).toEqual({ status: "idle" })
    expect(storeB.read()).toBeNull()
    // The other tab hears the record go and lets go of its hold.
    expect(b.controller.getState()).toEqual({ status: "idle" })
    // And can send: nothing is held any more.
    await b.controller.deposit("1000000")
    expect(b.api.wrap.prepare).toHaveBeenCalledTimes(1)
    expect(a.api.wrap.prepare).not.toHaveBeenCalled()
  })

  it("looks into a wrap another tab sends after this one opened, and holds when it cannot tell", async () => {
    const { a, b, storeA } = twoTabs(null)
    expect(b.controller.getState()).toEqual({ status: "idle" })

    storeA.record(SAVED)

    await settle(b.controller, "held")
    expect(b.api.wrap.prepare).not.toHaveBeenCalled()
    // The tab that wrote it is not told to look at its own record.
    expect(a.controller.getState()).toEqual({ status: "idle" })
  })

  it("is let go in the other tab when the wrap is found confirmed there", async () => {
    const { a, b } = twoTabs()
    a.controller.start()
    b.controller.start()
    await settle(a.controller, "held")
    await settle(b.controller, "held")

    a.api.wrap.confirm.mockReset().mockResolvedValue(receipt("a"))
    await a.controller.check()
    await settle(a.controller, "resolved")

    expect(a.controller.getState()).toMatchObject({
      status: "resolved",
      outcome: "confirmed",
    })
    expect(b.controller.getState()).toEqual({ status: "idle" })
  })

  it("can be asked about again from a held tab", async () => {
    const { a } = twoTabs()
    a.controller.start()
    await settle(a.controller, "held")

    a.api.wrap.confirm
      .mockReset()
      .mockRejectedValue(new ApiError(409, "transaction_failed"))
    await a.controller.check()

    expect(a.controller.getState()).toMatchObject({
      status: "resolved",
      outcome: "failed",
    })
  })

  it("releases nothing unless it is held, and not while it is working", async () => {
    const { a, storeA } = twoTabs()
    a.controller.release()
    expect(storeA.read()).not.toBeNull()

    const fresh = setup()
    fresh.controller.release()
    expect(fresh.controller.getState()).toEqual({ status: "idle" })
  })

  it("ignores another wallet's record", async () => {
    const { b, storeA } = twoTabs(null)
    storeA.record({
      ...SAVED,
      wallet: "SomeOtherWallet1111111111111111111111111111",
    })
    expect(b.controller.getState()).toEqual({ status: "idle" })
  })
})

// The release is made on the record the person saw, under the lock, and refused otherwise.
describe("MakePrivateController: releasing a hold on a stale view", () => {
  const viewer = { company: "Solaris", email: "ana@solaris.test" }
  const SAVED: Submission = {
    kind: "wrap",
    request_id: prepared("a").request_id,
    signature: SIG,
    last_valid_block_height: 500,
    wallet: COMPANY_WALLET,
    at: 1_000_000,
  }

  // The second tab's storage events are swallowed: it never hears of the first's changes.
  async function frozenTab() {
    const profile = browserProfile()
    const storeA = submissionStore("wrap", viewer, profile.tab())
    const storeB = submissionStore("wrap", viewer, profile.tab())
    storeA.record(SAVED)
    const a = setup({ sharedStore: storeA })
    const b = setup({ sharedStore: storeB })
    for (const tab of [a, b]) {
      tab.api.wrap.confirm.mockRejectedValue(
        new ApiError(404, "wrap_not_found"),
      )
    }
    b.controller.start()
    await vi.waitFor(() => expect(b.controller.getState().status).toBe("held"))
    return { a, b, storeA, storeB }
  }

  it("does not clear the wrap another tab sent after releasing the one this tab saw", async () => {
    const { a, b, storeA, storeB } = await frozenTab()
    // The first tab releases, and sends a new wrap that is in flight (no signature yet).
    storeA.clear()
    const fresh = {
      ...SAVED,
      request_id: prepared("f").request_id,
      signature: null,
      at: 1_000_473,
    }
    storeA.record(fresh)
    b.advance(1_000_000)

    expect(await b.controller.release()).toBe("changed")

    expect(storeB.read()).toMatchObject({ request_id: fresh.request_id })
    expect(b.api.wrap.prepare).not.toHaveBeenCalled()
    expect(a.api.wrap.prepare).not.toHaveBeenCalled()
  })

  it("looks again at what is saved now when its release was refused", async () => {
    const { b, storeA } = await frozenTab()
    storeA.clear()
    storeA.record({
      ...SAVED,
      request_id: prepared("f").request_id,
      at: 2_000_000,
    })
    b.advance(1_000_000)
    b.api.wrap.confirm
      .mockReset()
      .mockRejectedValue(new ApiError(404, "wrap_not_found"))

    await b.controller.release()

    // It is looking into the other record (and will hold on that one), not the stale one.
    await vi.waitFor(() =>
      expect(b.controller.getState()).toMatchObject({
        status: "held",
        requestId: prepared("f").request_id,
      }),
    )
  })

  it("refuses while another tab holds the lock, and keeps the record", async () => {
    const profile = browserProfile()
    const store = submissionStore("wrap", viewer, profile.tab())
    store.record(SAVED)
    const tab = setup({
      sharedStore: store,
      lock: async () => ({ status: "busy" }),
    })
    tab.api.wrap.confirm.mockRejectedValue(new ApiError(404, "wrap_not_found"))
    // Held on mount needs the lock to look: take it for that, then let another tab have it.
    let busy = false
    const open = setup({
      sharedStore: store,
      lock: async () =>
        busy
          ? { status: "busy" }
          : { status: "held", lease: { release: () => {} } },
    })
    open.api.wrap.confirm.mockRejectedValue(new ApiError(404, "wrap_not_found"))
    open.controller.start()
    await vi.waitFor(() =>
      expect(open.controller.getState().status).toBe("held"),
    )
    busy = true
    open.advance(1_000_000)

    expect(await open.controller.release()).toBe("busy")

    expect(store.read()).not.toBeNull()
    expect(open.controller.getState()).toMatchObject({ status: "held" })
  })

  it("refuses before two minutes, even on the record it saw", async () => {
    const { b, storeB } = await frozenTab()

    expect(await b.controller.release()).toBe("too-soon")

    expect(storeB.read()).not.toBeNull()
  })
})
