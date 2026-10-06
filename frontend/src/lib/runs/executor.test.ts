import { describe, expect, it, vi } from "vitest"
import { ApiError, ContractError } from "@/lib/api/errors"
import type { Receipt, Run, RunPayment } from "@/lib/api/schemas"
import { ConfirmTimeoutError } from "@/lib/api/sign"
import { ResponseMismatchError, SentPaymentError } from "./errors"
import {
  confirmPosition,
  paymentKey,
  payOne,
  paySequence,
  recheckOne,
  retryablePositions,
  retryRun,
  signablesOf,
  type RunApi,
  type RunContext,
  type Signable,
} from "./executor"

const RUN = "c0000000-0000-4000-8000-000000000001"
const requestId = (n: number) => String(n).padStart(64, "0")

function payment(n: number, patch: Partial<RunPayment> = {}): RunPayment {
  return {
    position: n,
    destination: `account${n}`,
    attempt: 0,
    request_id: requestId(n),
    status: "prepared",
    signature: null,
    slot: null,
    error: null,
    ...patch,
  }
}

function prepared(n: number): Signable {
  return {
    ...payment(n),
    request_id: requestId(n),
    transaction: "AQID",
    last_valid_block_height: 1,
    required_signers: ["wallet"],
  }
}

function runOf(
  payments: RunPayment[],
  errors?: { position: number; error: string }[],
): Run {
  return {
    run_id: RUN,
    company_wallet: "wallet",
    sender: "sender",
    mint: "mint",
    transaction_version: 1,
    required_signers: ["wallet"],
    status: "prepared",
    payments,
    ...(errors ? { errors } : {}),
  }
}

// What a confirm of one position answers when it landed.
const finalized = (n: number, signature: string) =>
  runOf([payment(n, { status: "finalized", signature, slot: 7 })])

const numberOf = (id: string) => Number(id.split(":")[1])

// A wallet that signs and sends instantly, with every call recorded in `log`. What the
// service answers to each confirm, and to a retry, is up to the test.
function harness(
  options: {
    confirm?: (position: number, signature: string) => Promise<Run>
    retry?: RunApi["retry"]
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
  const api = {
    confirm: vi.fn<RunApi["confirm"]>(async (_run, item) => {
      log.push(`confirm ${item.position} ${item.signature}`)
      return (
        options.confirm ??
        (async (position, signature) => finalized(position, signature))
      )(item.position, item.signature)
    }),
    retry: vi.fn<RunApi["retry"]>(async (run, request) => {
      log.push(`retry ${request.payments.map((p) => p.position).join(",")}`)
      if (!options.retry) throw new Error("no retry expected")
      return options.retry(run, request)
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

const created = (count: number) =>
  Array.from({ length: count }, (_, i) => prepared(i + 1))

const key = (n: number) => paymentKey(RUN, n)

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

  it("reports each step, then confirms its position with its own attempt", async () => {
    const { context, log, api } = harness()
    expect(await payOne(context, prepared(1))).toBe(true)
    expect(log).toEqual([
      "signing 1", // the payment is picked up
      "signing 1", // the wallet signs
      "signing 1", // sending still counts as signing
      "submitted 1 sig-1",
      "waiting 1",
      "confirm 1 sig-1",
      "confirmed 1",
    ])
    expect(api.confirm).toHaveBeenCalledWith(RUN, {
      position: 1,
      request_id: requestId(1),
      signature: "sig-1",
    })
  })

  it("signs with the run's signers", async () => {
    const sign = vi.fn<RunContext["sign"]>(async () => ({}) as Receipt)
    const { context } = harness({ sign })
    await payOne(context, prepared(1))
    expect(sign.mock.calls[0][0]).toMatchObject({
      transaction: "AQID",
      required_signers: ["wallet"],
    })
  })

  it("reports a failure instead of throwing, and says it did not finalize", async () => {
    const error = new ApiError(409, "transaction_failed")
    const { context, events } = harness({
      confirm: async () => {
        throw error
      },
    })
    await expect(payOne(context, prepared(1))).resolves.toBe(false)
    expect(events.failed).toHaveBeenCalledWith(key(1), error)
    expect(events.confirmed).not.toHaveBeenCalled()
  })

  it("is silent when the page is left, since nothing failed", async () => {
    const stop = new AbortController()
    const { context, events } = harness({
      signal: stop.signal,
      onSign: () => stop.abort(),
    })
    expect(await payOne(context, prepared(1))).toBe(false)
    expect(events.failed).not.toHaveBeenCalled()
    expect(events.confirmed).not.toHaveBeenCalled()
  })
})

describe("paySequence", () => {
  it("signs one payment at a time, in ascending position", async () => {
    const { context, log, maxOverlap } = harness()
    const payments = created(3)
    expect(await paySequence(context, [...payments].reverse())).toBeNull()
    expect(maxOverlap()).toBe(1)
    const confirmed = log.filter((entry) => entry.startsWith("confirmed"))
    expect(confirmed).toEqual(["confirmed 1", "confirmed 2", "confirmed 3"])
    // The next one starts only after the previous one is confirmed.
    expect(log.indexOf("confirmed 1")).toBeLessThan(log.indexOf("signing 2"))
    expect(log.indexOf("confirmed 2")).toBeLessThan(log.indexOf("signing 3"))
  })

  it("stops at the first payment that does not finalize, and signs none after it", async () => {
    const { context, events } = harness({
      confirm: async (position, signature) => {
        if (position === 2) throw new ApiError(409, "transaction_failed")
        return finalized(position, signature)
      },
    })
    expect(await paySequence(context, created(3))).toBe(2)
    expect(events.confirmed.mock.calls.map(([id]) => numberOf(id))).toEqual([1])
    expect(events.failed.mock.calls.map(([id]) => numberOf(id))).toEqual([2])
    expect(events.signing.mock.calls.some(([id]) => numberOf(id) === 3)).toBe(
      false,
    )
  })

  it("stops at a cancelled signature too", async () => {
    const { context, events } = harness({
      sign: async (_p, _c, onStep) => {
        onStep?.("signing")
        throw Object.assign(new Error("no"), {
          name: "UserRejectedRequestError",
        })
      },
    })
    expect(await paySequence(context, created(3))).toBe(1)
    expect(events.signing.mock.calls.every(([id]) => numberOf(id) === 1)).toBe(
      true,
    )
  })

  it("pays a single recipient", async () => {
    const { context, events } = harness()
    expect(await paySequence(context, created(1))).toBeNull()
    expect(events.confirmed).toHaveBeenCalledTimes(1)
  })

  it("stops starting payments once the page is left", async () => {
    const stop = new AbortController()
    const { context, events } = harness({
      signal: stop.signal,
      onSign: () => stop.abort(),
    })
    expect(await paySequence(context, created(3))).toBe(1)
    const touched = new Set(events.signing.mock.calls.map(([id]) => id))
    expect([...touched]).toEqual([key(1)])
    expect(events.failed).not.toHaveBeenCalled()
  })
})

describe("confirmPosition", () => {
  const api = (answer: Run): RunApi => ({
    confirm: async () => answer,
    retry: async () => answer,
  })
  const ask = (answer: Run) =>
    confirmPosition(api(answer), RUN, prepared(1), "sig")

  it("answers a receipt once the service recorded the position finalized", async () => {
    expect(await ask(finalized(1, "sig"))).toEqual({
      request_id: requestId(1),
      signature: "sig",
      slot: 7,
      status: "finalized",
    })
  })

  it("throws the network's refusal for a failed position", async () => {
    const error = await ask(
      runOf([payment(1, { status: "failed", error: "transaction_failed" })]),
    ).catch((e: unknown) => e)
    expect(error).toMatchObject({ status: 409, code: "transaction_failed" })
  })

  it("turns an item error into an ApiError, busy ones as passing with time", async () => {
    const itemError = async (code: string) =>
      (await ask(runOf([payment(1)], [{ position: 1, error: code }])).catch(
        (e: unknown) => e,
      )) as ApiError
    const notYet = await itemError("transaction_not_finalized")
    expect(notYet).toMatchObject({ status: 409 })
    expect(notYet.isRetryable).toBe(true)
    for (const busy of ["rpc_unavailable", "run_storage_unavailable"]) {
      const error = await itemError(busy)
      expect(error).toMatchObject({ status: 503, code: busy })
      expect(error.isRetryable).toBe(true)
    }
    const mismatch = await itemError("transaction_mismatch")
    expect(mismatch).toMatchObject({ status: 409 })
    expect(mismatch.isRetryable).toBe(false)
  })

  it("reads only the error of its own position", async () => {
    expect(
      await ask(
        runOf(
          [payment(1, { status: "finalized", signature: "sig", slot: 7 })],
          [{ position: 2, error: "transaction_mismatch" }],
        ),
      ),
    ).toMatchObject({ status: "finalized" })
  })

  it("is not finalized yet while the position is still prepared", async () => {
    expect(
      await ask(runOf([payment(1)])).catch((e: unknown) => e),
    ).toMatchObject({ code: "transaction_not_finalized" })
  })

  it("refuses an answer without the position or for another attempt", async () => {
    expect(
      await ask(runOf([payment(2)])).catch((e: unknown) => e),
    ).toBeInstanceOf(ResponseMismatchError)
    expect(
      await ask(
        runOf([
          payment(1, {
            status: "finalized",
            request_id: "f".repeat(64),
            signature: "sig",
          }),
        ]),
      ).catch((e: unknown) => e),
    ).toBeInstanceOf(ResponseMismatchError)
  })
})

describe("signablesOf and retryablePositions", () => {
  it("lists the positions that came with a transaction, in order, with the run's signers", () => {
    const run = runOf([
      { ...prepared(3), required_signers: undefined } as unknown as RunPayment,
      payment(2, {
        status: "preparation_failed",
        request_id: null,
        error: "proof_generation_failed",
      }),
      { ...prepared(1) },
    ])
    expect(signablesOf(run).map((p) => p.position)).toEqual([1, 3])
    expect(signablesOf(run)[0].required_signers).toEqual(["wallet"])
  })

  it("retries only what did not land and is not in flight", () => {
    const run = runOf([
      payment(0, { status: "finalized" }),
      payment(1, { status: "failed" }),
      payment(2, { status: "expired" }),
      payment(3, { status: "preparation_failed" }),
      payment(4),
      payment(5, { status: "something_new" }),
    ])
    expect(retryablePositions(run)).toEqual([1, 2, 3])
  })
})

describe("retryRun", () => {
  const before = runOf([
    payment(1, { status: "finalized" }),
    payment(2, { status: "failed", error: "transaction_failed" }),
    payment(3, { status: "preparation_failed", request_id: null }),
  ])
  const request = {
    aes_key: "AAAAAAAAAAAAAAAAAAAAAA==",
    payments: [
      { position: 2, amount: "1000000" },
      { position: 3, amount: "2000000" },
    ],
  }
  const rebuilt = (n: number) => ({
    ...prepared(n),
    attempt: 1,
    request_id: requestId(10 + n),
    required_signers: undefined,
  })

  it("asks for the positions with their amounts and returns what came back to sign, in order", async () => {
    const after = runOf([
      payment(1, { status: "finalized" }),
      rebuilt(3) as unknown as RunPayment,
      rebuilt(2) as unknown as RunPayment,
    ])
    const { context, api, events } = harness({ retry: async () => after })
    const signables = await retryRun(context, before, request)
    expect(api.retry).toHaveBeenCalledWith(RUN, request)
    expect(signables?.map((p) => [p.position, p.attempt])).toEqual([
      [2, 1],
      [3, 1],
    ])
    expect(signables?.[0].required_signers).toEqual(["wallet"])
    // Nothing is signed here: the caller holds them and signs them in order. Nor is
    // anything shown as signing, which a sequence that stops early would leave behind.
    expect(api.confirm).not.toHaveBeenCalled()
    expect(events.failed).not.toHaveBeenCalled()
    expect(events.signing).not.toHaveBeenCalled()
  })

  it("reports every position asked about as failed, with the refusal, and signs nothing", async () => {
    const refusal = new ApiError(409, "outstanding_payments")
    const { context, events, api } = harness({
      retry: async () => {
        throw refusal
      },
    })
    expect(await retryRun(context, before, request)).toBeNull()
    expect(events.failed.mock.calls).toEqual([
      [key(2), refusal],
      [key(3), refusal],
    ])
    expect(api.confirm).not.toHaveBeenCalled()
  })

  it("is silent about a refusal when the page is left", async () => {
    const stop = new AbortController()
    stop.abort()
    const { context, events } = harness({
      signal: stop.signal,
      retry: async () => {
        throw new Error("aborted")
      },
    })
    expect(await retryRun(context, before, request)).toBeNull()
    expect(events.failed).not.toHaveBeenCalled()
  })

  it.each([
    [
      "another account at a position",
      runOf([
        payment(1, { status: "finalized" }),
        { ...rebuilt(2), destination: "elsewhere" } as unknown as RunPayment,
        rebuilt(3) as unknown as RunPayment,
      ]),
    ],
    [
      "a position missing",
      runOf([
        payment(1, { status: "finalized" }),
        rebuilt(2) as unknown as RunPayment,
      ]),
    ],
    [
      "a transaction for a position not asked about",
      runOf([
        rebuilt(1) as unknown as RunPayment,
        rebuilt(2) as unknown as RunPayment,
        rebuilt(3) as unknown as RunPayment,
      ]),
    ],
  ])("refuses an answer with %s, and signs nothing", async (_name, after) => {
    const { context, failures } = harness({ retry: async () => after })
    expect(await retryRun(context, before, request)).toBeNull()
    expect(failures).toHaveLength(2)
    for (const failure of failures) {
      expect(failure).toBeInstanceOf(ResponseMismatchError)
    }
  })

  it("keeps the service's word for a position asked about that did not come back prepared", async () => {
    const after = runOf([
      payment(1, { status: "finalized" }),
      rebuilt(2) as unknown as RunPayment,
      payment(3, {
        status: "preparation_failed",
        request_id: null,
        attempt: 1,
        error: "proof_generation_failed",
      }),
    ])
    const { context, events } = harness({ retry: async () => after })
    const signables = await retryRun(context, before, request)
    expect(signables?.map((p) => p.position)).toEqual([2])
    expect(events.failed).toHaveBeenCalledTimes(1)
    expect(events.failed.mock.calls[0][0]).toBe(key(3))
    expect(events.failed.mock.calls[0][1]).toMatchObject({
      code: "proof_generation_failed",
    })
  })
})

describe("recheckOne", () => {
  it("asks about the same signature and never signs again", async () => {
    const { context, api, events } = harness()
    await recheckOne(context, prepared(1), "sig-kept")
    expect(api.confirm).toHaveBeenCalledWith(RUN, {
      position: 1,
      request_id: requestId(1),
      signature: "sig-kept",
    })
    expect(events.confirmed).toHaveBeenCalledWith(key(1))
    expect(api.retry).not.toHaveBeenCalled()
    expect(events.submitted).not.toHaveBeenCalled()
  })

  it("keeps the payment as sent, with its signature, while the network hasn't finalized", async () => {
    const { context, failures } = harness({
      confirm: async () => runOf([payment(1)]),
    })
    await recheckOne(context, prepared(1), "sig-kept")
    expect(failures[0]).toBeInstanceOf(SentPaymentError)
    expect((failures[0] as SentPaymentError).signature).toBe("sig-kept")
  })

  it("passes the network's own rejection through", async () => {
    const { context, failures } = harness({
      confirm: async () =>
        runOf([payment(1, { status: "failed", error: "transaction_failed" })]),
    })
    await recheckOne(context, prepared(1), "sig-kept")
    expect(failures[0]).toMatchObject({ code: "transaction_failed" })
    expect(failures[0]).not.toBeInstanceOf(SentPaymentError)
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
    expect(api.retry).not.toHaveBeenCalled()
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
    expect(api.confirm).not.toHaveBeenCalled()
  })

  it("says nothing when the page is left in the middle of the confirm", async () => {
    const stop = new AbortController()
    const { context, events } = harness({
      signal: stop.signal,
      confirm: () =>
        new Promise<Run>((_resolve, reject) => {
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

  it("stops the run there, and never retries the sent one by itself", async () => {
    const { context, events, api, failures } = harness({
      confirm: async (position, signature) => {
        if (position === 1) throw new ApiError(500, "internal_error")
        return finalized(position, signature)
      },
    })
    expect(await paySequence(context, created(3))).toBe(1)
    expect(events.confirmed).not.toHaveBeenCalled()
    expect(failures).toHaveLength(1)
    expect(failures[0]).toBeInstanceOf(SentPaymentError)
    expect(api.retry).not.toHaveBeenCalled()
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
      await recheckOne(context, prepared(1), "sig-kept")
      expect(failures[0]).toBeInstanceOf(SentPaymentError)
      expect(failures[0]).toMatchObject({ signature: "sig-kept" })
      expect(api.retry).not.toHaveBeenCalled()
    }
  })

  it("lets the network rejecting a rechecked payment end it as failed", async () => {
    const rejected = new ApiError(409, "transaction_failed")
    const { context, failures } = harness({
      confirm: async () => {
        throw rejected
      },
    })
    await recheckOne(context, prepared(1), "sig-kept")
    expect(failures[0]).toBe(rejected)
  })
})
