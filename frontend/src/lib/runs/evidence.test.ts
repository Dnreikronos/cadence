import { describe, expect, it, vi } from "vitest"
import { ApiError } from "@/lib/api/errors"
import type { RunPaymentPrepared } from "@/lib/api/schemas"
import type { SubmissionStorage } from "@/lib/submissions"
import {
  PAYMENT_KIND,
  paymentResolved,
  paymentSending,
  paymentSubmitted,
  recordEvidence,
  runEvidence,
  runEvidenceFor,
  unsettledPeople,
  type SentPayment,
} from "./evidence"
import { SentPaymentError } from "./errors"
import { paymentKey, type RunEvents } from "./executor"

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
  position: n,
  attempt: 0,
  request_id: String(n).padStart(64, "0"),
  last_valid_block_height: 500 + n,
})
// Who position n pays.
const person = (n: number) => guid(100 + n)
const key = (n: number) => paymentKey(RUN, n)
const sending = (
  evidence: ReturnType<typeof runEvidence>,
  n: number,
  at = 1_000,
  runId = RUN,
) => paymentSending(evidence, runId, prepared(n), person(n), at)
const SIG = "5SigMockSignature1111111111111111111111111111"

describe("what is kept", () => {
  it("holds no amount and no secret, under its own kind", () => {
    const storage = fakeStorage()
    const evidence = runEvidence(ana, storage)
    sending(evidence, 1)
    const stored = [...storage.items.values()].join("")
    expect(stored).not.toMatch(/amount/)
    expect([...storage.items.keys()].join("")).not.toContain("ana")
    expect([...storage.items.keys()].join("")).toContain(`:${PAYMENT_KIND}:`)
  })

  it("never reads a record of the shape before #107's runs as one of its own", () => {
    expect(PAYMENT_KIND).not.toBe("payroll-payment")
  })
})

describe("payments", () => {
  it("are written before the send, completed with the signature, and read back after a reload", () => {
    const storage = fakeStorage()
    const evidence = runEvidence(ana, storage)
    sending(evidence, 1)
    expect(runEvidence(ana, storage).payments.read()).toEqual([
      {
        run_id: RUN,
        position: 1,
        attempt: 0,
        request_id: prepared(1).request_id,
        person_id: guid(101),
        signature: null,
        last_valid_block_height: 501,
        at: 1_000,
      },
    ])
    paymentSubmitted(evidence, key(1), SIG)
    const [saved] = runEvidence(ana, storage).payments.read()
    expect(saved).toMatchObject({ signature: SIG, at: 1_000 })
  })

  it("keeps one record per position, so a retry's attempt replaces the earlier send", () => {
    const evidence = runEvidence(ana, fakeStorage())
    sending(evidence, 1)
    paymentSubmitted(evidence, key(1), SIG)
    paymentSending(
      evidence,
      RUN,
      { ...prepared(1), attempt: 1, request_id: "f".repeat(64) },
      person(1),
      9_000,
    )
    expect(evidence.payments.read()).toEqual([
      expect.objectContaining({
        attempt: 1,
        request_id: "f".repeat(64),
        signature: null,
        at: 9_000,
      }),
    ])
  })

  it("keeps the same position of two runs apart", () => {
    const evidence = runEvidence(ana, fakeStorage())
    const OTHER = "c0000000-0000-4000-8000-000000000002"
    sending(evidence, 0)
    sending(evidence, 0, 1_000, OTHER)
    expect(evidence.payments.read()).toHaveLength(2)
    paymentResolved(evidence, key(0))
    expect(evidence.payments.read()).toEqual([
      expect.objectContaining({ run_id: OTHER, position: 0 }),
    ])
  })

  it("ignores a signature for a payment that has no record", () => {
    const evidence = runEvidence(ana, fakeStorage())
    paymentSubmitted(evidence, key(9), SIG)
    expect(evidence.payments.read()).toEqual([])
  })

  it("makes whoever has one open not payable, and nobody else", () => {
    const evidence = runEvidence(ana, fakeStorage())
    sending(evidence, 1)
    sending(evidence, 2)
    paymentResolved(evidence, key(1))
    expect([...unsettledPeople(evidence.payments.read())]).toEqual([guid(102)])
    expect(unsettledPeople([]).size).toBe(0)
  })
})

describe("viewers", () => {
  it("keep their records apart, in storage and in the shared objects", () => {
    const storage = fakeStorage()
    const anas = runEvidence(ana, storage)
    sending(anas, 1)

    const brunos = runEvidence(bruno, storage)
    expect(brunos.payments.read()).toEqual([])

    // Bruno settling his own touches nothing of Ana's, even at the same position.
    sending(brunos, 1)
    paymentResolved(brunos, key(1))
    expect(runEvidence(ana, storage).payments.read()).toHaveLength(1)
  })

  it("is the same object for a viewer on a tab and another for the next one", () => {
    const first = runEvidenceFor({ company: "Test Co", email: "a@test.io" })
    expect(runEvidenceFor({ company: "Test Co", email: "a@test.io" })).toBe(
      first,
    )
    const next = runEvidenceFor({ company: "Test Co", email: "b@test.io" })
    sending(first, 1)
    // Signing out clears the query cache and not this; the next person sees none of it.
    expect(next.payments.read()).toEqual([])
    paymentResolved(first, key(1))
  })
})

describe("without storage", () => {
  it("still holds a payment for as long as the page lives", () => {
    for (const storage of [null, blocked]) {
      const evidence = runEvidence(ana, storage)
      sending(evidence, 1)
      expect(evidence.payments.read()).toHaveLength(1)
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
    const events = recordEvidence(inner, evidence, RUN, person, () => 7_000)
    return { evidence, inner, events }
  }
  const asPrepared = (n: number) => prepared(n) as unknown as RunPaymentPrepared

  it("keeps the record from the send until the payment is confirmed, and passes every event on", () => {
    const { evidence, inner, events } = wrapped()
    events.sending?.(asPrepared(1))
    expect(evidence.payments.read()).toEqual([
      expect.objectContaining({
        position: 1,
        person_id: person(1),
        signature: null,
        at: 7_000,
      }),
    ])
    events.submitted(key(1), SIG)
    expect(evidence.payments.read()[0].signature).toBe(SIG)
    events.confirmed(key(1))
    expect(evidence.payments.read()).toEqual([])
    expect(inner.sending).toHaveBeenCalledWith(asPrepared(1))
    expect(inner.submitted).toHaveBeenCalledWith(key(1), SIG)
    expect(inner.confirmed).toHaveBeenCalledWith(key(1))
  })

  it("keeps it when the payment may have been sent and could not be confirmed", () => {
    const { evidence, inner, events } = wrapped()
    events.sending?.(asPrepared(1))
    events.submitted(key(1), SIG)
    const error = new SentPaymentError(new ApiError(500, "internal_error"), SIG)
    events.failed(key(1), error)
    expect(evidence.payments.read()).toHaveLength(1)
    expect(inner.failed).toHaveBeenCalledWith(key(1), error)
  })

  it("drops it when the network refused the payment, or it failed before being sent", () => {
    const { evidence, events } = wrapped()
    events.sending?.(asPrepared(1))
    events.failed(key(1), new ApiError(409, "transaction_failed"))
    expect(evidence.payments.read()).toEqual([])

    events.failed(key(2), new Error("You cancelled"))
    expect(evidence.payments.read()).toEqual([])
  })

  it("leaves the others' records alone", () => {
    const { evidence, events } = wrapped()
    events.sending?.(asPrepared(1))
    events.sending?.(asPrepared(2))
    events.confirmed(key(1))
    expect(
      evidence.payments.read().map((p: SentPayment) => p.position),
    ).toEqual([2])
  })
})
