import { describe, expect, it, vi } from "vitest"
import { ApiError } from "@/lib/api/errors"
import type { RunPaymentPrepared } from "@/lib/api/schemas"
import type { SubmissionStorage } from "@/lib/submissions"
import {
  attemptCreated,
  attemptMaxAgeMs,
  beginAttempt,
  dropAttempt,
  paymentResolved,
  paymentSending,
  paymentSubmitted,
  recordEvidence,
  runEvidence,
  runEvidenceFor,
  savedAttempt,
  settleAttempts,
  unsettledPeople,
  type SentPayment,
} from "./evidence"
import { SentPaymentError } from "./errors"
import type { RunEvents } from "./executor"

function fakeStorage(): SubmissionStorage & { items: Map<string, string> } {
  const items = new Map<string, string>()
  return {
    items,
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => void items.set(key, value),
    removeItem: (key) => void items.delete(key),
  }
}

const blocked: SubmissionStorage = {
  getItem: () => {
    throw new Error("blocked")
  },
  setItem: () => {
    throw new Error("blocked")
  },
  removeItem: () => {
    throw new Error("blocked")
  },
}

const ana = { company: "Solaris", email: "ana@example.com" }
const bruno = { company: "Solaris", email: "bruno@example.com" }
const RUN = "c0000000-0000-4000-8000-000000000001"
const guid = (n: number) =>
  `b0000000-0000-4000-8000-${String(n).padStart(12, "0")}`
const prepared = (n: number) => ({
  payment_id: guid(n),
  person_id: guid(100 + n),
  request_id: String(n).padStart(64, "0"),
  last_valid_block_height: 500 + n,
})
const SIG = "5SigMockSignature1111111111111111111111111111"

describe("attempts", () => {
  it("is found for exactly the same list, and for no other", () => {
    const evidence = runEvidence(ana, fakeStorage())
    beginAttempt(evidence, { idempotency_key: "k1", fingerprint: "f1" }, 1_000)
    expect(savedAttempt(evidence, "f1", 2_000)).toEqual({
      idempotency_key: "k1",
      fingerprint: "f1",
      created_at: 1_000,
    })
    expect(savedAttempt(evidence, "f2", 2_000)).toBeNull()
  })

  it("survives a reload, so the same list replays with the saved key", () => {
    const storage = fakeStorage()
    beginAttempt(
      runEvidence(ana, storage),
      { idempotency_key: "k1", fingerprint: "f1" },
      1_000,
    )
    const reloaded = runEvidence(ana, storage)
    expect(savedAttempt(reloaded, "f1", 5_000)?.idempotency_key).toBe("k1")
  })

  it("keeps the time and the run when the same attempt is begun again", () => {
    const evidence = runEvidence(ana, fakeStorage())
    beginAttempt(evidence, { idempotency_key: "k1", fingerprint: "f1" }, 1_000)
    attemptCreated(evidence, "f1", RUN)
    beginAttempt(evidence, { idempotency_key: "k1", fingerprint: "f1" }, 9_000)
    expect(savedAttempt(evidence, "f1", 10_000)).toMatchObject({
      created_at: 1_000,
      run_id: RUN,
    })
    // A different key for the same list is a new attempt, without the old run.
    beginAttempt(evidence, { idempotency_key: "k2", fingerprint: "f1" }, 9_000)
    expect(savedAttempt(evidence, "f1", 10_000)).toEqual({
      idempotency_key: "k2",
      fingerprint: "f1",
      created_at: 9_000,
    })
  })

  it("is not replayed once it is a day old: its run could be long expired", () => {
    const evidence = runEvidence(ana, fakeStorage())
    beginAttempt(evidence, { idempotency_key: "k1", fingerprint: "f1" }, 1_000)
    expect(savedAttempt(evidence, "f1", 1_000 + attemptMaxAgeMs)).not.toBeNull()
    expect(savedAttempt(evidence, "f1", 1_000 + attemptMaxAgeMs + 1)).toBeNull()
  })

  it("is dropped when the service refused the request outright", () => {
    const evidence = runEvidence(ana, fakeStorage())
    beginAttempt(evidence, { idempotency_key: "k1", fingerprint: "f1" }, 1_000)
    beginAttempt(evidence, { idempotency_key: "k2", fingerprint: "f2" }, 1_000)
    dropAttempt(evidence, "f1")
    expect(savedAttempt(evidence, "f1", 2_000)).toBeNull()
    expect(savedAttempt(evidence, "f2", 2_000)).not.toBeNull()
  })

  it("holds no amount and no secret", () => {
    const storage = fakeStorage()
    const evidence = runEvidence(ana, storage)
    beginAttempt(evidence, { idempotency_key: "k1", fingerprint: "f1" }, 1_000)
    paymentSending(evidence, RUN, prepared(1), 1_000)
    const stored = [...storage.items.values()].join("")
    expect(stored).not.toMatch(/amount/)
    expect([...storage.items.keys()].join("")).not.toContain("ana")
  })
})

describe("settling attempts", () => {
  it("clears an attempt once its run has no payment left that may have been sent", () => {
    const evidence = runEvidence(ana, fakeStorage())
    beginAttempt(evidence, { idempotency_key: "k1", fingerprint: "f1" }, 1_000)
    attemptCreated(evidence, "f1", RUN)
    paymentSending(evidence, RUN, prepared(1), 1_000)
    paymentSending(evidence, RUN, prepared(2), 1_000)
    paymentResolved(evidence, guid(1))
    // One payment is still open.
    expect(savedAttempt(evidence, "f1", 2_000)).not.toBeNull()
    paymentResolved(evidence, guid(2))
    expect(savedAttempt(evidence, "f1", 2_000)).toBeNull()
    expect(evidence.payments.read()).toEqual([])
  })

  it("keeps an attempt that has no run yet: its key is for the replay", () => {
    const evidence = runEvidence(ana, fakeStorage())
    beginAttempt(evidence, { idempotency_key: "k1", fingerprint: "f1" }, 1_000)
    settleAttempts(evidence)
    expect(savedAttempt(evidence, "f1", 2_000)).not.toBeNull()
  })

  it("keeps an attempt while another run's payment is the open one, and clears the right one", () => {
    const evidence = runEvidence(ana, fakeStorage())
    const OTHER = "c0000000-0000-4000-8000-000000000002"
    beginAttempt(evidence, { idempotency_key: "k1", fingerprint: "f1" }, 1_000)
    attemptCreated(evidence, "f1", RUN)
    beginAttempt(evidence, { idempotency_key: "k2", fingerprint: "f2" }, 1_000)
    attemptCreated(evidence, "f2", OTHER)
    paymentSending(evidence, OTHER, prepared(7), 1_000)
    settleAttempts(evidence)
    // The first run has nothing open; the second has a payment that may be out.
    expect(savedAttempt(evidence, "f1", 2_000)).toBeNull()
    expect(savedAttempt(evidence, "f2", 2_000)).not.toBeNull()
  })
})

describe("payments", () => {
  it("are written before the send, completed with the signature, and read back after a reload", () => {
    const storage = fakeStorage()
    const evidence = runEvidence(ana, storage)
    paymentSending(evidence, RUN, prepared(1), 1_000)
    expect(runEvidence(ana, storage).payments.read()).toEqual([
      {
        payment_id: guid(1),
        run_id: RUN,
        person_id: guid(101),
        request_id: prepared(1).request_id,
        signature: null,
        last_valid_block_height: 501,
        at: 1_000,
      },
    ])
    paymentSubmitted(evidence, guid(1), SIG)
    const [saved] = runEvidence(ana, storage).payments.read()
    expect(saved).toMatchObject({ signature: SIG, at: 1_000 })
  })

  it("keeps one record per payment, so a retry replaces the earlier send", () => {
    const evidence = runEvidence(ana, fakeStorage())
    paymentSending(evidence, RUN, prepared(1), 1_000)
    paymentSubmitted(evidence, guid(1), SIG)
    paymentSending(
      evidence,
      RUN,
      { ...prepared(1), request_id: "f".repeat(64) },
      9_000,
    )
    expect(evidence.payments.read()).toEqual([
      expect.objectContaining({
        request_id: "f".repeat(64),
        signature: null,
        at: 9_000,
      }),
    ])
  })

  it("ignores a signature for a payment that has no record", () => {
    const evidence = runEvidence(ana, fakeStorage())
    paymentSubmitted(evidence, guid(9), SIG)
    expect(evidence.payments.read()).toEqual([])
  })

  it("makes whoever has one open not payable, and nobody else", () => {
    const evidence = runEvidence(ana, fakeStorage())
    paymentSending(evidence, RUN, prepared(1), 1_000)
    paymentSending(evidence, RUN, prepared(2), 1_000)
    paymentResolved(evidence, guid(1))
    expect([...unsettledPeople(evidence.payments.read())]).toEqual([guid(102)])
    expect(unsettledPeople([]).size).toBe(0)
  })
})

describe("viewers", () => {
  it("keep their records apart, in storage and in the shared objects", () => {
    const storage = fakeStorage()
    const anas = runEvidence(ana, storage)
    paymentSending(anas, RUN, prepared(1), 1_000)
    beginAttempt(anas, { idempotency_key: "k1", fingerprint: "f1" }, 1_000)

    const brunos = runEvidence(bruno, storage)
    expect(brunos.payments.read()).toEqual([])
    expect(savedAttempt(brunos, "f1", 2_000)).toBeNull()

    // Bruno settling or clearing his own touches nothing of Ana's.
    paymentSending(brunos, RUN, prepared(2), 1_000)
    paymentResolved(brunos, guid(2))
    dropAttempt(brunos, "f1")
    expect(runEvidence(ana, storage).payments.read()).toHaveLength(1)
    expect(savedAttempt(runEvidence(ana, storage), "f1", 2_000)).not.toBeNull()
  })

  it("is the same object for a viewer on a tab and another for the next one", () => {
    const first = runEvidenceFor({ company: "Test Co", email: "a@test.io" })
    expect(runEvidenceFor({ company: "Test Co", email: "a@test.io" })).toBe(
      first,
    )
    const next = runEvidenceFor({ company: "Test Co", email: "b@test.io" })
    paymentSending(first, RUN, prepared(1), 1_000)
    // Signing out clears the query cache and not this; the next person sees none of it.
    expect(next.payments.read()).toEqual([])
    paymentResolved(first, guid(1))
  })
})

describe("without storage", () => {
  it("still holds a payment and an attempt for as long as the page lives", () => {
    for (const storage of [null, blocked]) {
      const evidence = runEvidence(ana, storage)
      beginAttempt(
        evidence,
        { idempotency_key: "k1", fingerprint: "f1" },
        1_000,
      )
      paymentSending(evidence, RUN, prepared(1), 1_000)
      expect(evidence.payments.read()).toHaveLength(1)
      expect(savedAttempt(evidence, "f1", 2_000)).not.toBeNull()
      expect([...unsettledPeople(evidence.payments.read())]).toEqual([
        guid(101),
      ])
      // After a reload there is nothing, as before records were kept.
      expect(runEvidence(ana, storage).payments.read()).toEqual([])
    }
  })
})

describe("recordEvidence", () => {
  function wrapped() {
    const evidence = runEvidence(ana, fakeStorage())
    const inner: RunEvents = {
      signing: vi.fn(),
      sending: vi.fn(),
      waiting: vi.fn(),
      submitted: vi.fn(),
      confirmed: vi.fn(),
      failed: vi.fn(),
    }
    const events = recordEvidence(inner, evidence, RUN, () => 7_000)
    return { evidence, inner, events }
  }
  const asPrepared = (n: number) => prepared(n) as unknown as RunPaymentPrepared

  it("keeps the record from the send until the payment is confirmed, and passes every event on", () => {
    const { evidence, inner, events } = wrapped()
    events.sending?.(asPrepared(1))
    expect(evidence.payments.read()).toEqual([
      expect.objectContaining({ signature: null, at: 7_000 }),
    ])
    events.submitted(guid(1), SIG)
    expect(evidence.payments.read()[0].signature).toBe(SIG)
    events.confirmed(guid(1))
    expect(evidence.payments.read()).toEqual([])
    expect(inner.sending).toHaveBeenCalledWith(asPrepared(1))
    expect(inner.submitted).toHaveBeenCalledWith(guid(1), SIG)
    expect(inner.confirmed).toHaveBeenCalledWith(guid(1))
  })

  it("keeps it when the payment may have been sent and could not be confirmed", () => {
    const { evidence, inner, events } = wrapped()
    events.sending?.(asPrepared(1))
    events.submitted(guid(1), SIG)
    const error = new SentPaymentError(new ApiError(500, "internal_error"), SIG)
    events.failed(guid(1), error)
    expect(evidence.payments.read()).toHaveLength(1)
    expect(inner.failed).toHaveBeenCalledWith(guid(1), error)
  })

  it("drops it when the network refused the payment, or it failed before being sent", () => {
    const { evidence, events } = wrapped()
    events.sending?.(asPrepared(1))
    events.failed(guid(1), new ApiError(409, "transaction_failed"))
    expect(evidence.payments.read()).toEqual([])

    events.failed(guid(2), new Error("You cancelled"))
    expect(evidence.payments.read()).toEqual([])
  })

  it("leaves the others' records alone", () => {
    const { evidence, events } = wrapped()
    events.sending?.(asPrepared(1))
    events.sending?.(asPrepared(2))
    events.confirmed(guid(1))
    expect(
      evidence.payments.read().map((p: SentPayment) => p.payment_id),
    ).toEqual([guid(2)])
  })
})
