import { describe, expect, it, vi } from "vitest"
import { ApiError, ContractError } from "@/lib/api/errors"
import type { Receipt, RunCreated, RunPaymentPrepared } from "@/lib/api/schemas"
import { ConfirmTimeoutError } from "@/lib/api/sign"
import { ResponseMismatchError, SentPaymentError } from "./errors"
import {
  payOne,
  paySequence,
  recheckOne,
  retryOne,
  type RunApi,
  type RunContext,
} from "./executor"

const RUN = "c0000000-0000-4000-8000-000000000001"
const guid = (n: number) =>
  `b0000000-0000-4000-8000-${String(n).padStart(12, "0")}`
const receipt: Receipt = {
  request_id: "a".repeat(64),
  signature: "x",
  slot: 1,
  status: "finalized",
}

function prepared(n: number): RunPaymentPrepared {
  return {
    payment_id: guid(n),
    person_id: guid(100 + n),
    request_id: String(n).padStart(64, "0"),
    transaction: "AQID",
    transaction_version: 1,
    required_signers: ["wallet"],
    recent_blockhash: "hash",
    last_valid_block_height: 1,
  }
}

const numberOf = (paymentId: string) => Number(paymentId.slice(-3))

// A wallet that signs and sends instantly, with every call recorded in `log`. What the
// network answers to each confirm, and to each retry, is up to the test.
function harness(
  options: {
    confirm?: (paymentId: string, signature: string) => Promise<Receipt>
    retry?: (paymentId: string) => Promise<RunPaymentPrepared>
    signal?: AbortSignal
    onSign?: () => void
    // Replaces the wallet, to fail at a chosen step.
    sign?: RunContext["sign"]
  } = {},
) {
  const log: string[] = []
  let active = 0
  let overlap = 0
  let sent = 0
  const defaultSign: RunContext["sign"] = async (
    _prepared,
    confirm,
    onStep,
    extra = {},
  ) => {
    active += 1
    overlap = Math.max(overlap, active)
    try {
      options.onSign?.()
      onStep?.("signing")
      await Promise.resolve()
      onStep?.("submitting")
      const signature = `sig-${++sent}`
      extra.onSubmitted?.(signature)
      extra.signal?.throwIfAborted()
      onStep?.("confirming")
      return await confirm(signature)
    } finally {
      active -= 1
    }
  }
  const sign = options.sign ?? defaultSign
  const failures: unknown[] = []
  const api: RunApi = {
    confirmPayment: vi.fn(async (_run, paymentId, signature) => {
      log.push(`confirm ${numberOf(paymentId)} ${signature}`)
      return (options.confirm ?? (async () => receipt))(paymentId, signature)
    }),
    retryPayment: vi.fn(async (_run, paymentId) => {
      log.push(`retry ${numberOf(paymentId)}`)
      return (options.retry ?? (async () => prepared(numberOf(paymentId))))(
        paymentId,
      )
    }),
  }
  const events = {
    signing: vi.fn((id: string) => log.push(`signing ${numberOf(id)}`)),
    waiting: vi.fn((id: string) => log.push(`waiting ${numberOf(id)}`)),
    submitted: vi.fn((id: string, signature: string) =>
      log.push(`submitted ${numberOf(id)} ${signature}`),
    ),
    confirmed: vi.fn((id: string) => log.push(`confirmed ${numberOf(id)}`)),
    failed: vi.fn((id: string, error: unknown) => {
      log.push(`failed ${numberOf(id)}`)
      failures.push(error)
    }),
  }
  const context: RunContext = {
    runId: RUN,
    sign,
    api,
    events,
    signal: options.signal,
  }
  return { context, api, events, log, failures, maxOverlap: () => overlap }
}

const created = (count: number): RunCreated => ({
  run_id: RUN,
  payments: Array.from({ length: count }, (_, i) => prepared(i + 1)),
})

describe("payOne", () => {
  it("says the payment is about to be sent before the send, once, with what was prepared", async () => {
    const { context, log } = harness()
    const sending = vi.fn<NonNullable<RunContext["events"]["sending"]>>(() => {
      log.push("sending")
    })
    await payOne(
      { ...context, events: { ...context.events, sending } },
      prepared(1),
    )
    expect(sending).toHaveBeenCalledTimes(1)
    expect(sending).toHaveBeenCalledWith(prepared(1))
    // After the wallet signed, before the network was handed anything.
    expect(log.indexOf("sending")).toBeGreaterThan(log.indexOf("signing 1"))
    expect(log.indexOf("sending")).toBeLessThan(
      log.indexOf("submitted 1 sig-1"),
    )
  })

  it("does not say it when the wallet refuses to sign: nothing may have been sent", async () => {
    const sending = vi.fn()
    const { context } = harness({
      sign: async (_p, _c, onStep) => {
        onStep?.("signing")
        throw new Error("You cancelled")
      },
    })
    await payOne(
      { ...context, events: { ...context.events, sending } },
      prepared(1),
    )
    expect(sending).not.toHaveBeenCalled()
  })

  it("reports each step, then confirms with the payment's own ids", async () => {
    const { context, log, api } = harness()
    await payOne(context, prepared(1))
    expect(log).toEqual([
      "signing 1", // the payment is picked up
      "signing 1", // the wallet signs
      "signing 1", // sending still counts as signing
      "submitted 1 sig-1",
      "waiting 1",
      "confirm 1 sig-1",
      "confirmed 1",
    ])
    expect(api.confirmPayment).toHaveBeenCalledWith(RUN, guid(1), "sig-1")
  })

  it("reports a failure instead of throwing", async () => {
    const error = new ApiError(409, "transaction_failed")
    const { context, events } = harness({
      confirm: async () => {
        throw error
      },
    })
    await expect(payOne(context, prepared(1))).resolves.toBeUndefined()
    expect(events.failed).toHaveBeenCalledWith(guid(1), error)
    expect(events.confirmed).not.toHaveBeenCalled()
  })

  it("is silent when the page is left, since nothing failed", async () => {
    const stop = new AbortController()
    const { context, events } = harness({
      signal: stop.signal,
      onSign: () => stop.abort(),
    })
    await payOne(context, prepared(1))
    expect(events.failed).not.toHaveBeenCalled()
    expect(events.confirmed).not.toHaveBeenCalled()
  })
})

describe("paySequence", () => {
  it("signs one payment at a time, in the order the service gave", async () => {
    const { context, log, maxOverlap } = harness()
    await paySequence(context, created(3).payments)
    expect(maxOverlap()).toBe(1)
    const confirmed = log.filter((entry) => entry.startsWith("confirmed"))
    expect(confirmed).toEqual(["confirmed 1", "confirmed 2", "confirmed 3"])
    // The next one starts only after the previous one is confirmed.
    expect(log.indexOf("confirmed 1")).toBeLessThan(log.indexOf("signing 2"))
    expect(log.indexOf("confirmed 2")).toBeLessThan(log.indexOf("signing 3"))
  })

  it("lets one failure pass: the others still go through", async () => {
    const { context, events, log } = harness({
      confirm: async (paymentId) => {
        if (numberOf(paymentId) === 2) {
          throw new ApiError(409, "transaction_failed")
        }
        return receipt
      },
    })
    await paySequence(context, created(3).payments)
    expect(events.confirmed.mock.calls.map(([id]) => numberOf(id))).toEqual([
      1, 3,
    ])
    expect(events.failed.mock.calls.map(([id]) => numberOf(id))).toEqual([2])
    expect(log.indexOf("failed 2")).toBeLessThan(log.indexOf("signing 3"))
  })

  it("pays a single recipient", async () => {
    const { context, events } = harness()
    await paySequence(context, created(1).payments)
    expect(events.confirmed).toHaveBeenCalledTimes(1)
  })

  it("stops starting payments once the page is left", async () => {
    const stop = new AbortController()
    const { context, events } = harness({
      signal: stop.signal,
      onSign: () => stop.abort(),
    })
    await paySequence(context, created(3).payments)
    const touched = new Set(events.signing.mock.calls.map(([id]) => id))
    expect([...touched]).toEqual([guid(1)])
    expect(events.failed).not.toHaveBeenCalled()
  })
})

describe("retryOne", () => {
  it("asks for a fresh transaction for that payment and signs it", async () => {
    const { context, api, log } = harness()
    await retryOne(context, guid(2))
    expect(api.retryPayment).toHaveBeenCalledWith(RUN, guid(2))
    expect(log.at(-1)).toBe("confirmed 2")
    expect(log.indexOf("retry 2")).toBeLessThan(
      log.indexOf("submitted 2 sig-1"),
    )
  })

  it("fails the payment, and signs nothing, when the service won't retry it", async () => {
    const error = new ApiError(409, "payment_not_retryable")
    const { context, api, events } = harness({
      retry: async () => {
        throw error
      },
    })
    await retryOne(context, guid(2))
    expect(events.failed).toHaveBeenCalledWith(guid(2), error)
    expect(api.confirmPayment).not.toHaveBeenCalled()
    expect(events.submitted).not.toHaveBeenCalled()
  })

  it("can fail again, and leaves the other payments alone", async () => {
    const { context, events } = harness({
      confirm: async () => {
        throw new ApiError(409, "transaction_failed")
      },
    })
    await retryOne(context, guid(2))
    expect(events.failed).toHaveBeenCalledTimes(1)
    expect(events.failed.mock.calls[0][0]).toBe(guid(2))
  })
})

describe("recheckOne", () => {
  it("asks about the same signature and never signs again", async () => {
    const { context, api, events } = harness()
    await recheckOne(context, guid(1), "sig-kept")
    expect(api.confirmPayment).toHaveBeenCalledWith(RUN, guid(1), "sig-kept")
    expect(events.confirmed).toHaveBeenCalledWith(guid(1))
    expect(api.retryPayment).not.toHaveBeenCalled()
    expect(events.submitted).not.toHaveBeenCalled()
  })

  it("keeps the payment as sent, with its signature, while the network hasn't finalized", async () => {
    const { context, failures } = harness({
      confirm: async () => {
        throw new ApiError(409, "transaction_not_finalized")
      },
    })
    await recheckOne(context, guid(1), "sig-kept")
    expect(failures[0]).toBeInstanceOf(SentPaymentError)
    expect((failures[0] as SentPaymentError).signature).toBe("sig-kept")
  })

  it("passes the network's own rejection through unchanged", async () => {
    const rejected = new ApiError(409, "transaction_failed")
    const { context, events } = harness({
      confirm: async () => {
        throw rejected
      },
    })
    await recheckOne(context, guid(1), "sig-kept")
    expect(events.failed).toHaveBeenCalledWith(guid(1), rejected)
  })
})

// A wallet that reaches a step and then fails there, as the real `signAndConfirm`
// reports its steps (signing, submitting, confirming).
function failingAt(
  step: "signing" | "submitting" | "confirming",
  error: unknown,
  options: { signature?: string } = {},
): RunContext["sign"] {
  return async (_prepared, _confirm, onStep, extra = {}) => {
    onStep?.("signing")
    if (step === "signing") throw error
    onStep?.("submitting")
    if (step === "submitting") throw error
    if (options.signature) extra.onSubmitted?.(options.signature)
    onStep?.("confirming")
    throw error
  }
}

describe("a payment that may have been sent is never replaced", () => {
  it("treats a submit that throws after the broadcast as sent, with nothing to ask about", async () => {
    const error = new Error("socket closed")
    const { context, failures, api } = harness({
      sign: failingAt("submitting", error),
    })
    await payOne(context, prepared(1))
    expect(failures).toHaveLength(1)
    expect(failures[0]).toBeInstanceOf(SentPaymentError)
    expect(failures[0]).toMatchObject({ original: error, signature: null })
    expect(api.retryPayment).not.toHaveBeenCalled()
  })

  it("treats a confirm that answers 500 as sent, with its signature", async () => {
    const error = new ApiError(500, "internal_error")
    const { context, failures } = harness({
      sign: failingAt("confirming", error, { signature: "sig-9" }),
    })
    await payOne(context, prepared(1))
    expect(failures[0]).toBeInstanceOf(SentPaymentError)
    expect(failures[0]).toMatchObject({ original: error, signature: "sig-9" })
  })

  it.each([
    ["401", new ApiError(401, "authentication_required")],
    ["400", new ApiError(400, "invalid_request")],
    ["a transaction mismatch", new ApiError(409, "transaction_mismatch")],
    ["a contract error", new ContractError("/runs/x/confirm", "drifted")],
    ["a plain error", new Error("boom")],
  ])("treats a confirm failing with %s as sent", async (_name, error) => {
    const { context, failures } = harness({
      sign: failingAt("confirming", error, { signature: "sig-9" }),
    })
    await payOne(context, prepared(1))
    expect(failures[0]).toBeInstanceOf(SentPaymentError)
    expect((failures[0] as SentPaymentError).signature).toBe("sig-9")
  })

  it("treats a confirm timeout as sent and takes the signature from it", async () => {
    const { context, failures } = harness({
      sign: failingAt("confirming", new ConfirmTimeoutError("sig-t")),
    })
    await payOne(context, prepared(1))
    expect(failures[0]).toBeInstanceOf(SentPaymentError)
    expect((failures[0] as SentPaymentError).signature).toBe("sig-t")
  })

  it("wraps a failure that comes through the real confirm callback", async () => {
    const { context, failures } = harness({
      confirm: async () => {
        throw new ApiError(500, "internal_error")
      },
    })
    await payOne(context, prepared(1))
    expect(failures[0]).toBeInstanceOf(SentPaymentError)
    expect((failures[0] as SentPaymentError).signature).toBe("sig-1")
  })

  it("lets the network's own rejection through as a plain failure: it did not land", async () => {
    const rejected = new ApiError(409, "transaction_failed")
    const { context, failures } = harness({
      sign: failingAt("confirming", rejected, { signature: "sig-9" }),
    })
    await payOne(context, prepared(1))
    expect(failures[0]).toBe(rejected)
  })

  it.each([
    [
      "the person rejecting the signature",
      Object.assign(new Error("denied"), { name: "UserRejectedRequestError" }),
    ],
    ["the wallet failing to sign", new Error("signer crashed")],
  ])("leaves %s as a plain failure: nothing was sent", async (_name, error) => {
    const { context, failures, api } = harness({
      sign: failingAt("signing", error),
    })
    await payOne(context, prepared(1))
    expect(failures[0]).toBe(error)
    expect(failures[0]).not.toBeInstanceOf(SentPaymentError)
    expect(api.confirmPayment).not.toHaveBeenCalled()
  })

  it("says nothing when the page is left in the middle of the confirm", async () => {
    const stop = new AbortController()
    const { context, events } = harness({
      signal: stop.signal,
      confirm: () =>
        new Promise<Receipt>((_resolve, reject) => {
          stop.signal.addEventListener("abort", () =>
            reject(stop.signal.reason),
          )
          stop.abort()
        }),
    })
    await payOne(context, prepared(1))
    expect(events.failed).not.toHaveBeenCalled()
    expect(events.confirmed).not.toHaveBeenCalled()
  })

  it("keeps going with the next payment, and never retries the sent one by itself", async () => {
    const { context, events, api, failures } = harness({
      confirm: async (paymentId) => {
        if (numberOf(paymentId) === 1) throw new ApiError(500, "internal_error")
        return receipt
      },
    })
    await paySequence(context, created(3).payments)
    expect(events.confirmed.mock.calls.map(([id]) => numberOf(id))).toEqual([
      2, 3,
    ])
    expect(failures).toHaveLength(1)
    expect(failures[0]).toBeInstanceOf(SentPaymentError)
    expect(api.retryPayment).not.toHaveBeenCalled()
  })

  it("never prepares anything when a sent payment is checked again, whatever the answer", async () => {
    for (const error of [
      new ApiError(500, "internal_error"),
      new ApiError(401, "authentication_required"),
      new ContractError("/x", "drifted"),
      new ApiError(409, "transaction_not_finalized"),
    ]) {
      const { context, api, failures } = harness({
        confirm: async () => {
          throw error
        },
      })
      await recheckOne(context, guid(1), "sig-kept")
      expect(failures[0]).toBeInstanceOf(SentPaymentError)
      expect(failures[0]).toMatchObject({ signature: "sig-kept" })
      expect(api.retryPayment).not.toHaveBeenCalled()
    }
  })

  it("lets the network rejecting a rechecked payment end it as failed", async () => {
    const rejected = new ApiError(409, "transaction_failed")
    const { context, failures } = harness({
      confirm: async () => {
        throw rejected
      },
    })
    await recheckOne(context, guid(1), "sig-kept")
    expect(failures[0]).toBe(rejected)
  })
})

describe("what comes back from a retry", () => {
  it("is refused, and nothing is signed, when it is for another payment", async () => {
    const { context, events, api, failures } = harness({
      retry: async () => prepared(3),
    })
    await retryOne(context, guid(2))
    expect(failures[0]).toBeInstanceOf(ResponseMismatchError)
    expect(events.submitted).not.toHaveBeenCalled()
    expect(api.confirmPayment).not.toHaveBeenCalled()
  })
})
