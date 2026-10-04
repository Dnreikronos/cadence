import { describe, expect, it, vi } from "vitest"
import { ApiError } from "@/lib/api/errors"
import type { Receipt, RunCreated, RunPaymentPrepared } from "@/lib/api/schemas"
import { ConfirmTimeoutError } from "@/lib/api/sign"
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
  } = {},
) {
  const log: string[] = []
  let active = 0
  let overlap = 0
  let sent = 0
  const sign: RunContext["sign"] = async (
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
    failed: vi.fn((id: string) => log.push(`failed ${numberOf(id)}`)),
  }
  const context: RunContext = {
    runId: RUN,
    sign,
    api,
    events,
    signal: options.signal,
  }
  return { context, api, events, log, maxOverlap: () => overlap }
}

const created = (count: number): RunCreated => ({
  run_id: RUN,
  payments: Array.from({ length: count }, (_, i) => prepared(i + 1)),
})

describe("payOne", () => {
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

  it("keeps waiting, with the signature, while the network hasn't finalized", async () => {
    const { context, events } = harness({
      confirm: async () => {
        throw new ApiError(409, "transaction_not_finalized")
      },
    })
    await recheckOne(context, guid(1), "sig-kept")
    const [id, error] = events.failed.mock.calls[0] as unknown as [
      string,
      unknown,
    ]
    expect(id).toBe(guid(1))
    expect(error).toBeInstanceOf(ConfirmTimeoutError)
    expect((error as ConfirmTimeoutError).signature).toBe("sig-kept")
  })

  it("passes a final answer through unchanged", async () => {
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
