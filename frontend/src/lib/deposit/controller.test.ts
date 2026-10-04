import { describe, expect, it, vi } from "vitest"
import { base64FromBytes } from "@/lib/api/base64"
import { ApiError } from "@/lib/api/errors"
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
import { EXPIRY_MS } from "./reconcile"

const SIG = "5SigMockSignature1111111111111111111111111111"
const receipt = (id: string): Receipt => ({
  request_id: id.repeat(64).slice(0, 64),
  signature: SIG,
  slot: 1,
  status: "finalized",
})
const prepared = (id: string) => ({
  request_id: id.repeat(64).slice(0, 64),
  transaction: base64FromBytes(Uint8Array.of(1, 2, 3)),
  transaction_version: 0 as const,
  required_signers: [COMPANY_WALLET],
  recent_blockhash: "blockhash",
  last_valid_block_height: 500,
})

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
    signAndConfirm?: Deps["signAndConfirm"]
  } = {},
) {
  let saved = options.saved ?? null
  let clock = 1_000_000
  const records: Submission[] = []
  const unavailable = options.storage === "unavailable"
  const store: Deps["store"] = {
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
    now: () => clock,
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
    expect(toast).toHaveBeenCalledWith("2500 USDC is now private")
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

    it("calls a wrap that never showed up failed only after its blockhash window", async () => {
      const harness = await leaveAfterSubmit()
      harness.api.wrap.confirm.mockRejectedValue(
        new ApiError(409, "transaction_not_finalized"),
      )
      const back = harness.revisit()

      back.start()
      await vi.waitFor(() => expect(back.getState().status).toBe("resolved"))

      expect(back.getState()).toEqual({ status: "resolved", outcome: "failed" })
      const waited = harness.sleep.mock.calls.reduce((sum, [ms]) => sum + ms, 0)
      expect(waited).toBeGreaterThanOrEqual(EXPIRY_MS - 3_000)
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
      const { controller, api, saved } = setup({
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
      // blockhash, then says it does not know.
      await controller.check()
      expect(controller.getState()).toEqual({
        status: "resolved",
        outcome: "unknown",
      })
      expect(saved()).toBeNull()
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
