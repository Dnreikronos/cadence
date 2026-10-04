import { describe, expect, it, vi } from "vitest"
import type { ApiClient } from "@/lib/api/client"
import { base64FromBytes } from "@/lib/api/base64"
import { ApiError } from "@/lib/api/errors"
import { COMPANY_WALLET } from "@/lib/api/mocks/db"
import { mockSigner } from "@/lib/api/mocks/signer"
import type { Receipt } from "@/lib/api/schemas"
import { ConfirmTimeoutError, UnexpectedSignerError } from "@/lib/api/sign"
import { bindSignAndConfirm } from "@/lib/wallet/sign-and-confirm"
import { WalletUnavailableError, type Wallet } from "@/lib/wallet/types"
import {
  canRetry,
  failureMessage,
  MakePrivateError,
  needsSetup,
  runMakePrivate,
} from "./make-private"
import type { MakePrivateStep } from "./types"

const SIG = "5SigMockSignature1111111111111111111111111111"

const prepared = (id: string) => ({
  request_id: id.repeat(64).slice(0, 64),
  transaction: base64FromBytes(Uint8Array.of(1, 2, 3)),
  transaction_version: 0 as const,
  required_signers: [COMPANY_WALLET],
  recent_blockhash: "blockhash",
  last_valid_block_height: 1,
})
const receipt = (id: string): Receipt => ({
  request_id: prepared(id).request_id,
  signature: SIG,
  slot: 1,
  status: "finalized",
})

function fakeApi() {
  const api = {
    wrap: {
      prepare: vi.fn(async () => ({
        ...prepared("a"),
        destination: "dest",
        mint: "mint",
        deposit_state: "pending_after_confirmation" as const,
      })),
      confirm: vi.fn(async () => receipt("a")),
    },
    accounts: {
      applyPending: vi.fn(async () => prepared("b")),
      confirmApplyPending: vi.fn(async () => receipt("b")),
    },
  }
  return api
}

// A wallet whose signing and submitting the test controls; everything between
// (the order, the bytes, the confirm call) is the real `signAndConfirm`.
function walletWith(overrides: Partial<Wallet> = {}) {
  const wallet: Wallet = {
    status: "ready",
    loading: false,
    address: COMPANY_WALLET,
    signer: mockSigner(COMPANY_WALLET),
    submit: vi.fn(async () => SIG),
    ...overrides,
  }
  return wallet
}

function setup(wallet = walletWith(), api = fakeApi()) {
  const steps: MakePrivateStep[] = []
  const confirmed: string[] = []
  const run = (options: Partial<Parameters<typeof runMakePrivate>[0]> = {}) =>
    runMakePrivate({
      from: "wrap",
      amount: "2500000000",
      wallet: COMPANY_WALLET,
      api: api as unknown as Pick<ApiClient, "wrap" | "accounts">,
      signAndConfirm: bindSignAndConfirm(wallet),
      onStep: (step) => steps.push(step),
      onConfirmed: (which) => confirmed.push(which),
      ...options,
    })
  return { api, wallet, steps, confirmed, run }
}

async function failure(promise: Promise<unknown>) {
  try {
    await promise
  } catch (error) {
    expect(error).toBeInstanceOf(MakePrivateError)
    return error as MakePrivateError
  }
  throw new Error("expected the flow to fail")
}

describe("runMakePrivate", () => {
  it("wraps, signs, waits, then applies the pending credit, in that order", async () => {
    const { api, wallet, steps, confirmed, run } = setup()

    await run()

    expect(api.wrap.prepare).toHaveBeenCalledWith(
      { company_wallet: COMPANY_WALLET, amount: "2500000000" },
      expect.anything(),
    )
    expect(api.wrap.confirm).toHaveBeenCalledWith(
      { request_id: prepared("a").request_id, signature: SIG },
      expect.anything(),
    )
    expect(api.accounts.applyPending).toHaveBeenCalledWith(
      COMPANY_WALLET,
      expect.anything(),
    )
    expect(api.accounts.confirmApplyPending).toHaveBeenCalledWith(
      { request_id: prepared("b").request_id, signature: SIG },
      expect.anything(),
    )
    expect(wallet.submit).toHaveBeenCalledTimes(2)
    expect(steps).toEqual(["preparing", "signing", "confirming", "applying"])
    expect(confirmed).toEqual(["wrap", "apply"])
    // Apply is only asked for once the wrap is confirmed.
    expect(api.wrap.confirm.mock.invocationCallOrder[0]).toBeLessThan(
      api.accounts.applyPending.mock.invocationCallOrder[0],
    )
  })

  it("starts at the apply step when the deposit is already pending", async () => {
    const { api, steps, confirmed, run } = setup()

    await run({ from: "apply", amount: "" })

    expect(api.wrap.prepare).not.toHaveBeenCalled()
    expect(steps).toEqual(["applying"])
    expect(confirmed).toEqual(["apply"])
  })

  it("passes the abort signal to every request and to the signing", async () => {
    const { api, run } = setup()
    const abort = new AbortController()

    await run({ signal: abort.signal })

    for (const call of [
      api.wrap.prepare,
      api.wrap.confirm,
      api.accounts.applyPending,
      api.accounts.confirmApplyPending,
    ]) {
      expect(call.mock.calls[0].at(-1)).toEqual({ signal: abort.signal })
    }
  })

  it("sends nothing more once it is aborted while signing", async () => {
    const abort = new AbortController()
    const wallet = walletWith({
      signer: {
        address: COMPANY_WALLET,
        // The person leaves the page while the wallet is asking.
        signTransaction: async (bytes) => {
          abort.abort(new Error("left"))
          return bytes
        },
      },
    })
    const { api, wallet: w, run } = setup(wallet)

    const error = await failure(run({ signal: abort.signal }))

    expect(error.cause).toMatchObject({ message: "left" })
    expect(w.submit).not.toHaveBeenCalled()
    expect(api.wrap.confirm).not.toHaveBeenCalled()
    expect(api.accounts.applyPending).not.toHaveBeenCalled()
  })

  describe("when it fails", () => {
    it("says the account needs activating, deposits nothing, and offers no retry", async () => {
      const { api, wallet, run } = setup()
      api.wrap.prepare.mockRejectedValue(
        new ApiError(409, "confidential_setup_required"),
      )

      const error = await failure(run())

      expect(error).toMatchObject({ step: "preparing", resume: "wrap" })
      expect(needsSetup(error)).toBe(true)
      expect(canRetry(error)).toBe(false)
      expect(wallet.submit).not.toHaveBeenCalled()
    })

    it("lets a busy service be retried from the start", async () => {
      const { api, run } = setup()
      api.wrap.prepare.mockRejectedValue(
        new ApiError(429, "wrap_rate_limited", 60),
      )

      const error = await failure(run())

      expect(error).toMatchObject({ step: "preparing", resume: "wrap" })
      expect(canRetry(error)).toBe(true)
      expect(failureMessage(error)).toBe(
        "Too many deposits at once. Wait a moment.",
      )
    })

    it("does not offer a retry for a refusal that would repeat", async () => {
      const { api, run } = setup()
      api.wrap.prepare.mockRejectedValue(new ApiError(409, "insufficient_usdc"))

      const error = await failure(run())

      expect(canRetry(error)).toBe(false)
      expect(failureMessage(error)).toBe("There isn't enough USDC for that.")
    })

    it("restarts at the wrap when signing fails before anything is submitted", async () => {
      const wallet = walletWith({
        signer: {
          address: COMPANY_WALLET,
          signTransaction: async () => {
            throw new Error("rejected in the wallet")
          },
        },
      })
      const { run } = setup(wallet)

      const error = await failure(run())

      expect(error).toMatchObject({ step: "signing", resume: "wrap" })
      expect(canRetry(error)).toBe(true)
      // The wallet's own words are never shown.
      expect(failureMessage(error)).toBe("Something went wrong. Try again.")
    })

    it("never offers a second deposit when the network has not confirmed the first", async () => {
      const { api, wallet, run } = setup()
      api.wrap.confirm.mockRejectedValue(new ApiError(404, "wrap_not_found"))

      const error = await failure(run())

      expect(wallet.submit).toHaveBeenCalledTimes(1)
      expect(error).toMatchObject({ step: "confirming", resume: "check" })
      expect(canRetry(error)).toBe(false)
    })

    it("never offers a second deposit when submit throws, since the node may have taken it", async () => {
      const wallet = walletWith({
        submit: vi.fn(async () => {
          throw new Error("RPC timed out after broadcast")
        }),
      })
      const { api, run } = setup(wallet)

      const error = await failure(run())

      expect(error).toMatchObject({ step: "confirming", resume: "check" })
      expect(canRetry(error)).toBe(false)
      expect(api.wrap.prepare).toHaveBeenCalledTimes(1)
      expect(api.wrap.confirm).not.toHaveBeenCalled()
    })

    it("tells the caller the wrap is going out before submit runs, and the signature after", async () => {
      const order: string[] = []
      const wallet = walletWith({
        submit: vi.fn(async () => {
          order.push("submit")
          return SIG
        }),
      })
      const { run } = setup(wallet)

      await run({
        onSubmitting: (wrap) => order.push(`submitting ${wrap.request_id}`),
        onSubmitted: (signature) => order.push(`submitted ${signature}`),
      })

      expect(order.slice(0, 3)).toEqual([
        `submitting ${prepared("a").request_id}`,
        "submit",
        `submitted ${SIG}`,
      ])
    })

    it("hands over the block height the transaction is good until", async () => {
      const { run } = setup()
      const seen = vi.fn()

      await run({ onSubmitting: seen })

      expect(seen).toHaveBeenCalledWith(
        expect.objectContaining({ last_valid_block_height: 1 }),
      )
    })

    it("does not say a wrap is going out when the person leaves while signing", async () => {
      const abort = new AbortController()
      const wallet = walletWith({
        signer: {
          address: COMPANY_WALLET,
          signTransaction: async (bytes) => {
            abort.abort(new Error("left"))
            return bytes
          },
        },
      })
      const { run } = setup(wallet)
      const seen = vi.fn()

      const error = await failure(
        run({ signal: abort.signal, onSubmitting: seen }),
      )

      expect(seen).not.toHaveBeenCalled()
      expect(error.resume).toBe("wrap")
    })

    it("looks before it retries when the apply goes out and is not confirmed", async () => {
      const { api, run } = setup()
      let calls = 0
      const signAndConfirm = vi.fn(
        async (_prepared, confirm, onStep, extra) => {
          if (++calls === 1) {
            onStep?.("signing")
            onStep?.("submitting")
            extra.onSubmitted?.(SIG)
            return confirm(SIG)
          }
          throw new ConfirmTimeoutError(SIG)
        },
      )

      const error = await failure(
        run({ signAndConfirm: signAndConfirm as never }),
      )

      expect(api.accounts.applyPending).toHaveBeenCalledTimes(1)
      expect(error).toMatchObject({ step: "applying", resume: "check" })
      expect(canRetry(error)).toBe(false)
      expect(failureMessage(error)).toMatch(/Check your balances/)
    })

    it("treats a confirm timeout as an unknown outcome, in plain words", async () => {
      const timeout = new ConfirmTimeoutError(SIG)
      const wrap = vi.fn(async (_prepared, _confirm, onStep, extra) => {
        onStep?.("signing")
        onStep?.("submitting")
        extra.onSubmitted?.(SIG)
        onStep?.("confirming")
        throw timeout
      })
      const { run } = setup()

      const error = await failure(run({ signAndConfirm: wrap as never }))

      expect(error).toMatchObject({ step: "confirming", resume: "check" })
      expect(canRetry(error)).toBe(false)
      expect(failureMessage(error)).toMatch(
        /Check your balances before trying again/,
      )
    })

    it("restarts at the wrap when the network says the transaction failed", async () => {
      const { api, run } = setup()
      api.wrap.confirm.mockRejectedValue(
        new ApiError(409, "transaction_failed"),
      )

      const error = await failure(run())

      expect(error).toMatchObject({ step: "confirming", resume: "wrap" })
      expect(canRetry(error)).toBe(true)
    })

    it("resumes at the apply step, not the wrap, once the deposit has landed", async () => {
      const { api, confirmed, run } = setup()
      api.accounts.applyPending.mockRejectedValue(
        new ApiError(409, "credit_counter_mismatch"),
      )

      const error = await failure(run())

      expect(error).toMatchObject({ step: "applying", resume: "apply" })
      expect(canRetry(error)).toBe(true)
      expect(confirmed).toEqual(["wrap"])
      expect(failureMessage(error)).toBe(
        "A payment arrived while we were updating your balance. Try again.",
      )

      // The retry the screen starts from there never touches the wrap again.
      api.accounts.applyPending.mockResolvedValue(prepared("b"))
      api.wrap.prepare.mockClear()
      await run({ from: "apply" })
      expect(api.wrap.prepare).not.toHaveBeenCalled()
      expect(confirmed).toEqual(["wrap", "apply"])
    })

    it("resumes at the apply step when the apply transaction itself fails", async () => {
      const { api, run } = setup()
      api.accounts.confirmApplyPending.mockRejectedValue(
        new ApiError(409, "transaction_failed"),
      )

      const error = await failure(run())

      expect(error).toMatchObject({ step: "applying", resume: "apply" })
    })
  })
})

describe("failureMessage", () => {
  it("names a wallet that cannot sign yet", () => {
    expect(
      failureMessage(new WalletUnavailableError("the mock is loading")),
    ).toBe("Your wallet isn't available yet, so nothing can be signed.")
  })

  it("explains a request for someone else's signature", () => {
    expect(failureMessage(new UnexpectedSignerError())).toMatch(
      /another wallet/,
    )
  })

  it("uses the contract's copy for an API error and never a raw message", () => {
    expect(failureMessage(new ApiError(503, "rpc_unavailable"))).toBe(
      "The network is busy. Try again shortly.",
    )
    expect(failureMessage(new Error("secret internals"))).toBe(
      "Something went wrong. Try again.",
    )
  })
})

describe("canRetry", () => {
  it("is false for anything that is not a flow failure", () => {
    expect(canRetry(new Error("x"))).toBe(false)
  })
})
