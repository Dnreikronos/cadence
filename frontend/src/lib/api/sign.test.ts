import { afterEach, describe, expect, it, vi } from "vitest"
import { ApiError } from "./errors"
import { base64FromBytes } from "./base64"
import { mockAccountTransaction } from "./mocks/chain"
import type { Receipt } from "./schemas"
import {
  ConfirmTimeoutError,
  FinalityMismatchError,
  UnexpectedSignerError,
  UnexpectedTransactionError,
  signAndConfirm,
  type Signer,
} from "./sign"

const ADDRESS = "4egAZELoLKWqJwHwAwaZwS2su9rewh7is3ukCagHnSQ5"
const SIGNATURE = "5SigMockSignature1111111111111111111111111111"
const receipt: Receipt = {
  request_id: "a".repeat(64),
  signature: SIGNATURE,
  slot: 1,
  status: "finalized",
}
const prepared = {
  transaction: base64FromBytes(
    mockAccountTransaction({ kind: "apply-pending", wallet: ADDRESS, n: 1 }),
  ),
  required_signers: [ADDRESS],
}

const signer: Signer = {
  address: ADDRESS,
  signTransaction: async (bytes) => Uint8Array.from([...bytes, 1]),
}
const submit = async () => SIGNATURE
// The network's own read agrees with the service.
const finality = async () => "finalized" as const
const notFinalized = () => new ApiError(409, "transaction_not_finalized")

// A clock that only moves when the code under test sleeps (or a call "takes
// time"), so a wait of a minute runs instantly and exactly.
function clock() {
  let time = 1_000
  const slept: number[] = []
  return {
    slept,
    now: () => time,
    advance: (ms: number) => {
      time += ms
    },
    sleep: async (ms: number) => {
      slept.push(ms)
      time += ms
    },
  }
}

const total = (values: number[]) => values.reduce((a, b) => a + b, 0)

// The thrown value, so a test can look at it.
async function caught(promise: Promise<unknown>) {
  try {
    await promise
  } catch (error) {
    return error
  }
  throw new Error("expected the call to fail")
}

afterEach(() => vi.useRealTimers())

describe("signAndConfirm: waiting", () => {
  it("backs off 2, 3, 4.5, 6.75, then 10 s, and never waits past the timeout", async () => {
    const c = clock()
    let confirms = 0
    const error = await caught(
      signAndConfirm(prepared, {
        signer,
        submit,
        finality,
        sleep: c.sleep,
        now: c.now,
        confirm: async () => {
          confirms++
          throw notFinalized()
        },
      }),
    )
    expect(error).toBeInstanceOf(ConfirmTimeoutError)
    expect(c.slept).toEqual([
      2_000, 3_000, 4_500, 6_750, 10_000, 10_000, 10_000, 10_000,
      // The last sleep is cut to what is left of the minute.
      3_750,
    ])
    expect(total(c.slept)).toBe(60_000)
    // One look after every sleep, and one first.
    expect(confirms).toBe(c.slept.length + 1)
  })

  it("counts the time a confirm itself takes", async () => {
    const c = clock()
    const start = c.now()
    const error = await caught(
      signAndConfirm(prepared, {
        signer,
        submit,
        finality,
        sleep: c.sleep,
        now: c.now,
        timeoutMs: 20_000,
        confirm: async () => {
          c.advance(4_000)
          throw notFinalized()
        },
      }),
    )
    expect(error).toBeInstanceOf(ConfirmTimeoutError)
    expect(c.now() - start).toBeLessThanOrEqual(20_000 + 4_000)
    // Without the request time the sleeps alone would have gone on to 20 s.
    expect(total(c.slept)).toBeLessThan(20_000)
  })

  it("names the submitted signature on a timeout", async () => {
    const c = clock()
    const error = await caught(
      signAndConfirm(prepared, {
        signer,
        submit,
        finality,
        sleep: c.sleep,
        now: c.now,
        timeoutMs: 1_000,
        confirm: async () => {
          throw notFinalized()
        },
      }),
    )
    expect(error).toBeInstanceOf(ConfirmTimeoutError)
    expect((error as ConfirmTimeoutError).signature).toBe(SIGNATURE)
  })

  it("reports the signature as soon as it is submitted, before the first confirm", async () => {
    const events: string[] = []
    await signAndConfirm(prepared, {
      signer,
      submit,
      finality,
      onStep: (step) => events.push(step),
      onSubmitted: (signature) => events.push(`submitted ${signature}`),
      confirm: async () => {
        events.push("confirm")
        return receipt
      },
    })
    expect(events).toEqual([
      "signing",
      "submitting",
      `submitted ${SIGNATURE}`,
      "confirming",
      "confirm",
    ])
  })
})

describe("signAndConfirm: which errors are retried", () => {
  async function succeedsAfter(failures: ApiError[]) {
    const c = clock()
    let confirms = 0
    const result = await signAndConfirm(prepared, {
      signer,
      submit,
      finality,
      sleep: c.sleep,
      now: c.now,
      confirm: async () => {
        if (confirms < failures.length) throw failures[confirms++]
        confirms++
        return receipt
      },
    })
    return { result, confirms, slept: c.slept }
  }

  it.each([
    ["503 rpc_unavailable", new ApiError(503, "rpc_unavailable")],
    ["503 transfer_timeout", new ApiError(503, "transfer_timeout")],
    ["502 from a proxy", new ApiError(502, "service_unavailable")],
    ["504 from a proxy", new ApiError(504, "service_unavailable")],
    ["a dropped connection", new ApiError(0, "network_error")],
  ])("retries %s and then succeeds", async (_, failure) => {
    const { result, confirms, slept } = await succeedsAfter([failure, failure])
    expect(result).toEqual(receipt)
    expect(confirms).toBe(3)
    expect(slept).toEqual([2_000, 3_000])
  })

  it("sleeps at least Retry-After on a 429", async () => {
    const { slept, confirms } = await succeedsAfter([
      new ApiError(429, "transfer_rate_limited", 30),
      new ApiError(429, "rate_limited", 1),
    ])
    expect(confirms).toBe(3)
    // 30 s is more than the 2 s backoff. 1 s is less than the 3 s one.
    expect(slept).toEqual([30_000, 3_000])
  })

  it("does not sleep past the deadline for a long Retry-After", async () => {
    const c = clock()
    const error = await caught(
      signAndConfirm(prepared, {
        signer,
        submit,
        finality,
        sleep: c.sleep,
        now: c.now,
        timeoutMs: 10_000,
        confirm: async () => {
          throw new ApiError(429, "rate_limited", 120)
        },
      }),
    )
    expect(error).toBeInstanceOf(ConfirmTimeoutError)
    expect(c.slept).toEqual([10_000])
  })

  it.each([
    ["a failed transaction", new ApiError(409, "transaction_failed")],
    ["a mismatch", new ApiError(409, "transaction_mismatch")],
    ["a server error", new ApiError(500, "internal_error")],
    ["a missing request", new ApiError(404, "wrap_not_found")],
    ["a bad signature", new ApiError(400, "invalid_signature")],
    ["a plain exception", new Error("boom")],
  ])("stops at once on %s, after exactly one confirm", async (_, failure) => {
    const c = clock()
    let confirms = 0
    const error = await caught(
      signAndConfirm(prepared, {
        signer,
        submit,
        finality,
        sleep: c.sleep,
        now: c.now,
        confirm: async () => {
          confirms++
          throw failure
        },
      }),
    )
    expect(error).toBe(failure)
    expect(confirms).toBe(1)
    expect(c.slept).toEqual([])
  })
})

describe("signAndConfirm: signers", () => {
  it("never signs for a key that is not the user's", async () => {
    const signTransaction = vi.fn(async (bytes: Uint8Array) => bytes)
    const error = await caught(
      signAndConfirm(
        { ...prepared, required_signers: [ADDRESS, "someone-else"] },
        {
          signer: { address: ADDRESS, signTransaction },
          submit,
          finality,
          confirm: vi.fn(),
        },
      ),
    )
    expect(error).toBeInstanceOf(UnexpectedSignerError)
    expect(signTransaction).not.toHaveBeenCalled()
  })

  it("refuses a transaction that names no signer at all", async () => {
    const signTransaction = vi.fn(async (bytes: Uint8Array) => bytes)
    const error = await caught(
      signAndConfirm(
        { ...prepared, required_signers: [] },
        {
          signer: { address: ADDRESS, signTransaction },
          submit,
          finality,
          confirm: vi.fn(),
        },
      ),
    )
    expect(error).toBeInstanceOf(UnexpectedSignerError)
    expect(signTransaction).not.toHaveBeenCalled()
  })
})

describe("signAndConfirm: abort", () => {
  it("throws the abort reason without doing anything when already aborted", async () => {
    const reason = new Error("left the page")
    const onStep = vi.fn()
    const confirm = vi.fn()
    const signTransaction = vi.fn(async (bytes: Uint8Array) => bytes)
    const error = await caught(
      signAndConfirm(prepared, {
        signer: { address: ADDRESS, signTransaction },
        submit,
        finality,
        onStep,
        confirm,
        signal: AbortSignal.abort(reason),
      }),
    )
    expect(error).toBe(reason)
    expect(onStep).not.toHaveBeenCalled()
    expect(signTransaction).not.toHaveBeenCalled()
    expect(confirm).not.toHaveBeenCalled()
  })

  it("stops polling when aborted while waiting", async () => {
    const reason = new Error("left the page")
    const controller = new AbortController()
    const c = clock()
    let confirms = 0
    const onStep = vi.fn()
    const error = await caught(
      signAndConfirm(prepared, {
        signer,
        submit,
        finality,
        onStep,
        now: c.now,
        signal: controller.signal,
        // Aborts during the sleep, and, like a sloppy sleep, returns normally.
        sleep: async (ms) => {
          c.advance(ms)
          controller.abort(reason)
        },
        confirm: async () => {
          confirms++
          throw notFinalized()
        },
      }),
    )
    expect(error).toBe(reason)
    expect(confirms).toBe(1)
    expect(onStep.mock.calls.map(([step]) => step)).toEqual([
      "signing",
      "submitting",
      "confirming",
    ])
  })

  it("cuts the default sleep short and clears its timer", async () => {
    vi.useFakeTimers()
    const reason = new Error("left the page")
    const controller = new AbortController()
    let confirms = 0
    const outcome = caught(
      signAndConfirm(prepared, {
        signer,
        submit,
        finality,
        signal: controller.signal,
        confirm: async () => {
          confirms++
          throw notFinalized()
        },
      }),
    )
    await vi.advanceTimersByTimeAsync(1_000)
    expect(vi.getTimerCount()).toBe(1)
    controller.abort(reason)
    expect(await outcome).toBe(reason)
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(confirms).toBe(1)
  })

  it("keeps the real default sleep on the schedule with fake timers", async () => {
    vi.useFakeTimers()
    let confirms = 0
    const done = signAndConfirm(prepared, {
      signer,
      submit,
      finality,
      confirm: async () => {
        if (++confirms < 3) throw notFinalized()
        return receipt
      },
    })
    await vi.advanceTimersByTimeAsync(1_999)
    expect(confirms).toBe(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(confirms).toBe(2)
    await vi.advanceTimersByTimeAsync(3_000)
    expect(await done).toEqual(receipt)
    expect(confirms).toBe(3)
  })
})

describe("signAndConfirm: the pre-sign check", () => {
  async function refused(
    transaction: Uint8Array,
    check?: Parameters<typeof signAndConfirm>[1]["check"],
  ) {
    const signTransaction = vi.fn(async (bytes: Uint8Array) => bytes)
    const submit = vi.fn(async () => SIGNATURE)
    const onStep = vi.fn()
    const error = await caught(
      signAndConfirm(
        {
          transaction: base64FromBytes(transaction),
          required_signers: [ADDRESS],
        },
        {
          signer: { address: ADDRESS, signTransaction },
          submit,
          finality,
          onStep,
          check,
          confirm: vi.fn(),
        },
      ),
    )
    expect(signTransaction).not.toHaveBeenCalled()
    expect(submit).not.toHaveBeenCalled()
    expect(onStep).not.toHaveBeenCalled()
    return error
  }

  it("never signs bytes that are not a transaction", async () => {
    const error = await refused(Uint8Array.of(1, 2, 3))
    expect(error).toBeInstanceOf(UnexpectedTransactionError)
    expect((error as UnexpectedTransactionError).reason).toBe("undecodable")
  })

  it("never signs a transaction another wallet pays for", async () => {
    const error = await refused(
      mockAccountTransaction({
        kind: "apply-pending",
        wallet: "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin",
        n: 2,
      }),
    )
    expect((error as UnexpectedTransactionError).reason).toBe("signer")
  })

  it("runs the flow's own check on the decoded transaction", async () => {
    const check = vi.fn(() => {
      throw new UnexpectedTransactionError("destination")
    })
    const error = await refused(
      mockAccountTransaction({ kind: "apply-pending", wallet: ADDRESS, n: 3 }),
      check,
    )
    expect((error as UnexpectedTransactionError).reason).toBe("destination")
    expect(check).toHaveBeenCalledWith(
      expect.objectContaining({ feePayer: ADDRESS, version: 1 }),
    )
  })
})

describe("signAndConfirm: the network's own read", () => {
  it("waits for the network to show the receipt's transaction finalized", async () => {
    const c = clock()
    const answers = ["pending", "pending", "finalized"] as const
    const reads: string[] = []
    const confirm = vi.fn(async () => receipt)
    const result = await signAndConfirm(prepared, {
      signer,
      submit,
      sleep: c.sleep,
      now: c.now,
      confirm,
      finality: async (signature) => {
        reads.push(signature)
        return answers[reads.length - 1]
      },
    })
    expect(result).toEqual(receipt)
    // The service is asked once; only the network read is repeated.
    expect(confirm).toHaveBeenCalledTimes(1)
    expect(reads).toEqual([SIGNATURE, SIGNATURE, SIGNATURE])
    expect(c.slept).toEqual([2_000, 3_000])
  })

  it("keeps reading when the read itself fails", async () => {
    const c = clock()
    let reads = 0
    const result = await signAndConfirm(prepared, {
      signer,
      submit,
      sleep: c.sleep,
      now: c.now,
      confirm: async () => receipt,
      finality: async () => {
        if (++reads === 1) throw new TypeError("Failed to fetch")
        return "finalized"
      },
    })
    expect(result).toEqual(receipt)
    expect(reads).toBe(2)
  })

  it("times out with the signature when the network never shows it", async () => {
    const c = clock()
    const error = await caught(
      signAndConfirm(prepared, {
        signer,
        submit,
        sleep: c.sleep,
        now: c.now,
        timeoutMs: 10_000,
        confirm: async () => receipt,
        finality: async () => "pending",
      }),
    )
    expect(error).toBeInstanceOf(ConfirmTimeoutError)
    expect(error).not.toBeInstanceOf(FinalityMismatchError)
    expect((error as ConfirmTimeoutError).signature).toBe(SIGNATURE)
  })

  it("does not take the service's word when the network says it failed", async () => {
    const c = clock()
    const error = await caught(
      signAndConfirm(prepared, {
        signer,
        submit,
        sleep: c.sleep,
        now: c.now,
        confirm: async () => receipt,
        finality: async () => "failed",
      }),
    )
    expect(error).toBeInstanceOf(FinalityMismatchError)
    // Still a sent payment whose outcome is unknown to the screens: never sent again.
    expect(error).toBeInstanceOf(ConfirmTimeoutError)
    expect((error as FinalityMismatchError).signature).toBe(SIGNATURE)
    expect(c.slept).toEqual([])
  })

  it("reads the signature it submitted, not the one the receipt names", async () => {
    const reads: string[] = []
    await caught(
      signAndConfirm(prepared, {
        signer,
        submit,
        timeoutMs: 0,
        confirm: async () => ({ ...receipt, signature: "another" }),
        finality: async (signature) => {
          reads.push(signature)
          return "pending"
        },
      }),
    )
    expect(reads).toEqual([SIGNATURE])
  })
})
