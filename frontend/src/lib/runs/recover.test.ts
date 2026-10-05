import { describe, expect, it, vi } from "vitest"
import { ApiError } from "@/lib/api/errors"
import type { Receipt, RunPaymentPrepared } from "@/lib/api/schemas"
import type { SubmissionStorage } from "@/lib/submissions"
import { PaymentNotOnChainError, SentPaymentError } from "./errors"
import {
  attemptCreated,
  beginAttempt,
  recordEvidence,
  runEvidence,
  savedAttempt,
  type SentPayment,
} from "./evidence"
import { payOne, paySequence, type RunApi, type RunContext } from "./executor"
import { sentWithoutSignatureMessage } from "./messages"
import {
  holdsUnconfirmed,
  localReducer,
  mergeRow,
  type LocalRows,
} from "./progress"
import { createHeldStore } from "./held"
import { runEvents } from "./sign-again"
import { holdChecking, type PayrollPerson } from "./plan"
import { hydrateLocal, reconcilePayment, recoverOne } from "./recover"

function fakeStorage(): SubmissionStorage {
  const items = new Map<string, string>()
  return {
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => void items.set(key, value),
    removeItem: (key) => void items.delete(key),
  }
}

const viewer = { company: "Solaris", email: "ana@example.com" }
const RUN = "c0000000-0000-4000-8000-000000000001"
const guid = (n: number) =>
  `b0000000-0000-4000-8000-${String(n).padStart(12, "0")}`
const SIG = "5SigMockSignature1111111111111111111111111111"
const receipt: Receipt = {
  request_id: "a".repeat(64),
  signature: SIG,
  slot: 1,
  status: "finalized",
}
const saved = (n: number, patch: Partial<SentPayment> = {}): SentPayment => ({
  payment_id: guid(n),
  run_id: RUN,
  person_id: guid(100 + n),
  request_id: String(n).padStart(64, "0"),
  signature: `sig-${n}`,
  last_valid_block_height: 500,
  at: 1_000,
  ...patch,
})
const notFinalized = () => new ApiError(409, "transaction_not_finalized")

function clock(start = 1_000) {
  let time = start
  return { now: () => time, sleep: async (ms: number) => void (time += ms) }
}

describe("hydrateLocal", () => {
  it("shows a saved payment with a signature as waiting, and one without as needing a check", () => {
    const rows = hydrateLocal([saved(1), saved(2, { signature: null })])
    expect(rows).toEqual({
      [guid(1)]: { status: "waiting", signature: "sig-1" },
      [guid(2)]: {
        status: "unknown",
        message: sentWithoutSignatureMessage,
      },
    })
    // A page left now would lose track of them again: the leave guard stays.
    expect(holdsUnconfirmed(rows)).toBe(true)
  })

  it("is empty when nothing was kept", () => {
    expect(hydrateLocal([])).toEqual({})
  })
})

describe("reconcilePayment", () => {
  const options = () => ({ ...clock(), pollMs: 3_000 })

  it("asks with the saved signature, and says confirmed once it is", async () => {
    const confirm = vi.fn(async () => receipt)
    expect(
      await reconcilePayment(saved(1), confirm, undefined, options()),
    ).toBe("confirmed")
    expect(confirm).toHaveBeenCalledWith("sig-1")
  })

  it("says failed when the network refused it", async () => {
    const confirm = vi
      .fn()
      .mockRejectedValue(new ApiError(409, "transaction_failed"))
    expect(
      await reconcilePayment(saved(1), confirm, undefined, options()),
    ).toBe("failed")
  })

  it("waits for a transaction not finalized yet", async () => {
    const confirm = vi
      .fn()
      .mockRejectedValueOnce(notFinalized())
      .mockRejectedValueOnce(notFinalized())
      .mockResolvedValue(receipt)
    expect(
      await reconcilePayment(saved(1), confirm, undefined, options()),
    ).toBe("confirmed")
    expect(confirm).toHaveBeenCalledTimes(3)
  })

  it("rules it lost only after 90 seconds from the send, and only if the service saw it missing", async () => {
    const confirm = vi.fn().mockRejectedValue(notFinalized())
    // Sent at t=1000, asked every 3 s, the last ask at t=91000: 31 asks, 90 s in all.
    const ticking = clock()
    expect(
      await reconcilePayment(saved(1), confirm, undefined, {
        ...ticking,
        pollMs: 3_000,
      }),
    ).toBe("failed")
    expect(confirm).toHaveBeenCalledTimes(31)
    expect(ticking.now()).toBe(1_000 + 90_000)

    // A service that never answers leaves it unknown.
    const down = vi
      .fn()
      .mockRejectedValue(new ApiError(503, "service_unavailable"))
    expect(await reconcilePayment(saved(1), down, undefined, options())).toBe(
      "unknown",
    )
  })

  it("leaves it unknown when the service no longer has it or answers unreadably", async () => {
    for (const failure of [
      new ApiError(404, "payment_not_found"),
      new TypeError("bad body"),
    ]) {
      const confirm = vi.fn().mockRejectedValue(failure)
      expect(
        await reconcilePayment(saved(1), confirm, undefined, options()),
      ).toBe("unknown")
    }
  })

  it("has nothing to ask about a payment with no signature", async () => {
    const confirm = vi.fn()
    expect(await reconcilePayment(saved(1, { signature: null }), confirm)).toBe(
      "unknown",
    )
    expect(confirm).not.toHaveBeenCalled()
  })

  it("stops when the page is left", async () => {
    const stop = new AbortController()
    const confirm = vi.fn().mockRejectedValue(notFinalized())
    await expect(
      reconcilePayment(saved(1), confirm, stop.signal, {
        now: () => 1_000,
        sleep: async () => stop.abort(),
      }),
    ).rejects.toBeDefined()
  })
})

// The events a screen would get, recorded, with the answers the test chooses.
function recovery(confirm: RunApi["confirmPayment"]) {
  const log: string[] = []
  const failures: unknown[] = []
  const sign = vi.fn()
  const retry = vi.fn()
  const context: RunContext = {
    runId: RUN,
    sign,
    api: { confirmPayment: confirm, retryPayment: retry },
    events: {
      signing: (id) => log.push(`signing ${id}`),
      waiting: (id) => log.push(`waiting ${id}`),
      submitted: (id) => log.push(`submitted ${id}`),
      confirmed: (id) => log.push(`confirmed ${id}`),
      failed: (id, error) => {
        log.push(`failed ${id}`)
        failures.push(error)
      },
    },
  }
  return { context, log, failures, sign, retry }
}
const quick = { ...clock(), pollMs: 3_000 }

describe("recoverOne", () => {
  it("shows the payment as waiting, then confirmed, and prepares and signs nothing", async () => {
    const { context, log, sign, retry } = recovery(async () => receipt)
    await recoverOne(context, saved(1), quick)
    expect(log).toEqual([`waiting ${guid(1)}`, `confirmed ${guid(1)}`])
    expect(sign).not.toHaveBeenCalled()
    expect(retry).not.toHaveBeenCalled()
  })

  it("asks with the run and payment it was saved with", async () => {
    const confirm = vi.fn(async () => receipt)
    const { context } = recovery(confirm)
    await recoverOne(context, saved(3, { run_id: "other-run" }), quick)
    expect(confirm).toHaveBeenCalledWith("other-run", guid(3), "sig-3")
  })

  it("reports a refused payment as one that did not go through, so a retry is offered", async () => {
    const { context, failures } = recovery(async () => {
      throw new ApiError(409, "transaction_failed")
    })
    await recoverOne(context, saved(1), quick)
    expect(failures).toEqual([expect.any(PaymentNotOnChainError)])
  })

  it("reports a payment it could not settle as sent, keeping its signature to check again", async () => {
    const { context, failures } = recovery(async () => {
      throw new ApiError(404, "payment_not_found")
    })
    await recoverOne(context, saved(1), quick)
    expect(failures).toHaveLength(1)
    expect(failures[0]).toBeInstanceOf(SentPaymentError)
    expect((failures[0] as SentPaymentError).signature).toBe("sig-1")
  })

  it("reports one with no signature as sent without one, and asks nothing", async () => {
    const confirm = vi.fn(async () => receipt)
    const { context, log, failures } = recovery(confirm)
    await recoverOne(context, saved(1, { signature: null }), quick)
    expect(log).toEqual([`failed ${guid(1)}`])
    expect((failures[0] as SentPaymentError).signature).toBeNull()
    expect(confirm).not.toHaveBeenCalled()
  })

  it("says nothing when the page is left", async () => {
    const stop = new AbortController()
    const { context, log } = recovery(async () => {
      throw notFinalized()
    })
    await recoverOne({ ...context, signal: stop.signal }, saved(1), {
      now: () => 1_000,
      sleep: async () => stop.abort(),
    })
    expect(log).toEqual([`waiting ${guid(1)}`])
  })
})

// A run that is signed in one page, left, and picked up in the next, with the records in
// between kept the way the screens keep them.
describe("a run reloaded mid-way", () => {
  const prepared = (n: number): RunPaymentPrepared => ({
    payment_id: guid(n),
    person_id: guid(100 + n),
    request_id: String(n).padStart(64, "0"),
    transaction: "AQID",
    transaction_version: 1,
    required_signers: ["wallet"],
    recent_blockhash: "hash",
    last_valid_block_height: 500,
  })

  // Two payments: the first is sent and its confirm is where the page is left.
  async function firstPage(storage: SubmissionStorage) {
    const evidence = runEvidence(viewer, storage)
    beginAttempt(evidence, { idempotency_key: "k1", fingerprint: "f1" }, 1_000)
    attemptCreated(evidence, "f1", RUN)
    const stop = new AbortController()
    let local: LocalRows = {}
    const events = recordEvidence(
      {
        signing: (id) => (local = localReducer(local, { type: "signing", id })),
        waiting: (id) => (local = localReducer(local, { type: "waiting", id })),
        submitted: (id, signature) =>
          (local = localReducer(local, { type: "submitted", id, signature })),
        confirmed: (id) =>
          (local = localReducer(local, { type: "confirmed", id })),
        failed: vi.fn(),
      },
      evidence,
      RUN,
      () => 2_000,
    )
    const sign: RunContext["sign"] = async (_p, confirm, onStep, extra) => {
      onStep?.("signing")
      onStep?.("submitting")
      extra?.onSubmitted?.("sig-1")
      onStep?.("confirming")
      // The page is closed while the network is asked.
      stop.abort()
      return confirm("sig-1")
    }
    const api: RunApi = {
      confirmPayment: async () => {
        throw notFinalized()
      },
      retryPayment: vi.fn(),
    }
    await paySequence({ runId: RUN, sign, api, events, signal: stop.signal }, [
      prepared(1),
      prepared(2),
    ])
    return evidence
  }

  it("keeps the first payment's signature and nothing for the one never sent", async () => {
    const storage = fakeStorage()
    await firstPage(storage)
    const next = runEvidence(viewer, storage)
    expect(next.payments.read()).toEqual([
      expect.objectContaining({
        payment_id: guid(1),
        signature: "sig-1",
        person_id: guid(101),
        at: 2_000,
      }),
    ])
    expect(savedAttempt(next, "f1", 3_000)).toMatchObject({ run_id: RUN })
  })

  it("asks about the sent payment with its signature, never signs, and clears the attempt once it is confirmed", async () => {
    const storage = fakeStorage()
    await firstPage(storage)

    // The next page: what it shows first, then what the lookup finds.
    const evidence = runEvidence(viewer, storage)
    let local = hydrateLocal(evidence.payments.read())
    expect(local[guid(1)]).toEqual({ status: "waiting", signature: "sig-1" })
    expect(local[guid(2)]).toBeUndefined()

    const confirm = vi.fn(async () => receipt)
    const sign = vi.fn()
    const events = recordEvidence(
      {
        signing: vi.fn(),
        waiting: (id) => (local = localReducer(local, { type: "waiting", id })),
        submitted: vi.fn(),
        confirmed: (id) =>
          (local = localReducer(local, { type: "confirmed", id })),
        failed: vi.fn(),
      },
      evidence,
      RUN,
    )
    for (const record of evidence.payments.read()) {
      await recoverOne(
        {
          runId: RUN,
          sign,
          api: { confirmPayment: confirm, retryPayment: vi.fn() },
          events,
        },
        record,
        quick,
      )
    }
    expect(confirm).toHaveBeenCalledWith(RUN, guid(1), "sig-1")
    expect(sign).not.toHaveBeenCalled()
    expect(local[guid(1)].status).toBe("confirmed")
    // Nothing is in doubt any more: the records and the attempt are gone.
    expect(evidence.payments.read()).toEqual([])
    expect(savedAttempt(evidence, "f1", 3_000)).toBeNull()
    expect(runEvidence(viewer, storage).payments.read()).toEqual([])
  })

  it("keeps the person unsettled while the lookup cannot say, and lets it be asked again", async () => {
    const storage = fakeStorage()
    await firstPage(storage)
    const evidence = runEvidence(viewer, storage)
    const failed = vi.fn()
    const events = recordEvidence(
      {
        signing: vi.fn(),
        waiting: vi.fn(),
        submitted: vi.fn(),
        confirmed: vi.fn(),
        failed,
      },
      evidence,
      RUN,
    )
    await recoverOne(
      {
        runId: RUN,
        sign: vi.fn(),
        api: {
          confirmPayment: async () => {
            throw new ApiError(0, "network_error")
          },
          retryPayment: vi.fn(),
        },
        events,
      },
      evidence.payments.read()[0],
      quick,
    )
    expect(failed).toHaveBeenCalledWith(guid(1), expect.any(SentPaymentError))
    // Still kept: the person stays out of the roster and the attempt stays.
    expect(evidence.payments.read()).toHaveLength(1)
  })

  it("keeps a payment sent with no signature across the reload, as needing a check", async () => {
    const storage = fakeStorage()
    const evidence = runEvidence(viewer, storage)
    const stop = new AbortController()
    const events = recordEvidence(
      {
        signing: vi.fn(),
        waiting: vi.fn(),
        submitted: vi.fn(),
        confirmed: vi.fn(),
        failed: vi.fn(),
      },
      evidence,
      RUN,
    )
    await payOne(
      {
        runId: RUN,
        sign: async (_p, _c, onStep) => {
          onStep?.("submitting")
          throw new Error("connection dropped")
        },
        api: { confirmPayment: vi.fn(), retryPayment: vi.fn() },
        events,
        signal: stop.signal,
      },
      prepared(1),
    )
    expect(runEvidence(viewer, storage).payments.read()).toEqual([
      expect.objectContaining({ payment_id: guid(1), signature: null }),
    ])
    expect(hydrateLocal(runEvidence(viewer, storage).payments.read())).toEqual({
      [guid(1)]: { status: "unknown", message: sentWithoutSignatureMessage },
    })
  })
})

// Persisted evidence together with the held transactions of a cancelled signature, the way
// the signer hook wires them.
describe("evidence beside held transactions", () => {
  const prepared = (n: number): RunPaymentPrepared => ({
    payment_id: guid(n),
    person_id: guid(100 + n),
    request_id: String(n).padStart(64, "0"),
    transaction: "AQID",
    transaction_version: 1,
    required_signers: ["wallet"],
    recent_blockhash: "hash",
    last_valid_block_height: 500,
  })
  function wired() {
    const evidence = runEvidence(viewer, fakeStorage())
    const held = createHeldStore()
    let local: LocalRows = {}
    const events = recordEvidence(
      runEvents(held, (action) => (local = localReducer(local, action))),
      evidence,
      RUN,
    )
    const context = (sign: RunContext["sign"]): RunContext => ({
      runId: RUN,
      sign,
      api: { confirmPayment: vi.fn(), retryPayment: vi.fn() },
      events,
    })
    return { evidence, held, local: () => local, context }
  }

  it("a cancelled signature keeps the transaction held and leaves no record: nothing was sent", async () => {
    const { evidence, held, local, context } = wired()
    held.hold(prepared(1))
    await payOne(
      context(async (_p, _c, onStep) => {
        onStep?.("signing")
        throw Object.assign(new Error("no"), {
          name: "UserRejectedRequestError",
        })
      }),
      prepared(1),
    )
    expect(local()[guid(1)].status).toBe("cancelled")
    expect(held.has(guid(1))).toBe(true)
    expect(evidence.payments.read()).toEqual([])
  })

  it("a send keeps the record and drops the held transaction, so it is never signed again", async () => {
    const { evidence, held, local, context } = wired()
    held.hold(prepared(1))
    await payOne(
      context(async (_p, _c, onStep, extra) => {
        onStep?.("submitting")
        extra?.onSubmitted?.("sig-1")
        throw new Error("connection dropped")
      }),
      prepared(1),
    )
    expect(held.has(guid(1))).toBe(false)
    expect(local()[guid(1)]).toMatchObject({ status: "waiting", stalled: true })
    expect(evidence.payments.read()).toEqual([
      expect.objectContaining({ payment_id: guid(1), signature: "sig-1" }),
    ])
  })

  it("a saved payment stays checking, and its person unpayable, whatever status the service reports", () => {
    const rows = hydrateLocal([saved(1)])
    for (const status of ["pending", "signed", "failed", "settled-somehow"]) {
      expect(
        mergeRow(rows[guid(1)], { status, failure: null }).status,
      ).not.toBe("confirmed")
    }
    expect(
      mergeRow(rows[guid(1)], { status: "settled-somehow", failure: null })
        .status,
    ).toBe("waiting")
    const people = [1, 2].map(
      (n) =>
        ({
          id: guid(100 + n),
          name: `P${n}`,
          email: "x@y.z",
          kind: "employee",
          activation: "active",
          amount: "1",
        }) satisfies PayrollPerson,
    )
    expect(
      holdChecking(people, new Set([guid(101)])).payable.map((p) => p.id),
    ).toEqual([guid(102)])
  })
})
