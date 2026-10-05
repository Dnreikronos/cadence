import { describe, expect, it, vi } from "vitest"
import type { RunPaymentPrepared } from "@/lib/api/schemas"
import {
  StorageUnavailableError,
  storageBlockedMessage,
} from "@/lib/storage-guard"
import { stableHash, type SubmissionStorage } from "@/lib/submissions"
import {
  attemptCreated,
  beginAttempt,
  canReleasePayment,
  paymentSending,
  recordEvidence,
  releaseAfterMs,
  releasePerson,
  releaseWarning,
  runEvidence,
  runSeenBefore,
  savedAttempt,
  unsettledPeople,
} from "./evidence"
import { payOne, type RunContext } from "./executor"
import { describeFailure } from "./messages"

function fakeStorage(): SubmissionStorage & { items: Map<string, string> } {
  const items = new Map<string, string>()
  return {
    items,
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => void items.set(key, value),
    removeItem: (key) => void items.delete(key),
  }
}

const refusing: SubmissionStorage = {
  getItem: () => null,
  setItem: () => {
    throw new Error("blocked")
  },
  removeItem: () => {},
}

const viewer = {
  company: "Solaris",
  companyId: "c0000000-0000-4000-8000-000000000001",
  email: "ana@example.com",
}
const RUN = "c0000000-0000-4000-8000-0000000000aa"
const guid = (n: number) =>
  `b0000000-0000-4000-8000-${String(n).padStart(12, "0")}`
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

// A payment that reaches the send step, where `send` is what must not run when it should not.
function context(
  evidence: ReturnType<typeof runEvidence>,
  mode: "mock" | "real",
  send: () => void,
) {
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
    () => 5_000,
    mode,
  )
  const ctx: RunContext = {
    runId: RUN,
    sign: async (_p, _c, onStep, extra) => {
      onStep?.("signing")
      onStep?.("submitting")
      send()
      extra?.onSubmitted?.("sig-1")
      throw new Error("not confirmed")
    },
    api: { confirmPayment: vi.fn(), retryPayment: vi.fn() },
    events,
  }
  return { ctx, failed }
}

describe("a payroll payment when storage cannot keep its record", () => {
  it("stops before the send in real mode, and says why, not that it may have been sent", async () => {
    const evidence = runEvidence(viewer, refusing)
    const send = vi.fn()
    const { ctx, failed } = context(evidence, "real", send)
    await payOne(ctx, prepared(1))
    expect(send).not.toHaveBeenCalled()
    const [, error] = failed.mock.calls[0]
    expect(error).toBeInstanceOf(StorageUnavailableError)
    expect(describeFailure(error)).toEqual({
      message: storageBlockedMessage,
      sent: false,
    })
    // Nothing was sent: nothing is held in memory, and nobody is blocked.
    expect(evidence.payments.read()).toEqual([])
    expect(unsettledPeople(evidence.payments.read()).size).toBe(0)
  })

  it("stops when storage worked for the probe and refuses this very write", async () => {
    let writes = 0
    const items = new Map<string, string>()
    const storage: SubmissionStorage = {
      getItem: (key) => items.get(key) ?? null,
      setItem: (key, value) => {
        // A sentinel write passes; the record's does not.
        if (key.includes("payroll-payment")) {
          writes += 1
          throw new Error("full")
        }
        items.set(key, value)
      },
      removeItem: (key) => void items.delete(key),
    }
    const evidence = runEvidence(viewer, storage)
    const send = vi.fn()
    await payOne(context(evidence, "real", send).ctx, prepared(1))
    expect(writes).toBe(1)
    expect(send).not.toHaveBeenCalled()
  })

  it("goes on in mock mode, with the record held in memory", async () => {
    const evidence = runEvidence(viewer, refusing)
    const send = vi.fn()
    await payOne(context(evidence, "mock", send).ctx, prepared(1))
    expect(send).toHaveBeenCalledTimes(1)
    expect(evidence.payments.read()).toHaveLength(1)
  })

  it("sends when storage works, in real mode", async () => {
    const evidence = runEvidence(viewer, fakeStorage())
    const send = vi.fn()
    await payOne(context(evidence, "real", send).ctx, prepared(1))
    expect(send).toHaveBeenCalledTimes(1)
  })

  it("does not call a send that was never made a sent one: the person can retry once storage works", async () => {
    const evidence = runEvidence(viewer, refusing)
    const { ctx, failed } = context(evidence, "real", vi.fn())
    await payOne(ctx, prepared(1))
    expect(describeFailure(failed.mock.calls[0][1]).sent).toBe(false)
  })
})

describe("releasing a person on purpose", () => {
  it("is offered after two minutes, for a payment nothing can be asked about or one a lookup could not settle", () => {
    const payment = {
      payment_id: guid(1),
      run_id: RUN,
      person_id: guid(101),
      request_id: "a".repeat(64),
      signature: "sig",
      last_valid_block_height: 1,
      at: 1_000,
    }
    const now = 1_000 + releaseAfterMs
    expect(canReleasePayment(payment, { now: now - 1, lookedUp: true })).toBe(
      false,
    )
    expect(canReleasePayment(payment, { now, lookedUp: false })).toBe(false)
    expect(canReleasePayment(payment, { now, lookedUp: true })).toBe(true)
    expect(
      canReleasePayment(
        { ...payment, signature: null },
        { now, lookedUp: false },
      ),
    ).toBe(true)
  })

  it("makes the person payable again, drops an attempt left with nothing open, and touches no one else", () => {
    const storage = fakeStorage()
    const evidence = runEvidence(viewer, storage)
    beginAttempt(evidence, { idempotency_key: "k", fingerprint: "f" }, 1_000)
    attemptCreated(evidence, "f", RUN)
    paymentSending(evidence, RUN, prepared(1), 1_000)
    paymentSending(evidence, RUN, prepared(2), 1_000)
    const others = runEvidence({ ...viewer, email: "b@example.com" }, storage)
    paymentSending(others, RUN, prepared(1), 1_000)

    releasePerson(evidence, guid(101))
    expect([...unsettledPeople(evidence.payments.read())]).toEqual([guid(102)])
    expect(savedAttempt(evidence, "f", 2_000)).not.toBeNull()
    releasePerson(evidence, guid(102))
    expect(unsettledPeople(evidence.payments.read()).size).toBe(0)
    expect(savedAttempt(evidence, "f", 2_000)).toBeNull()
    // Another viewer's payment is still held, and it is still released after a reload.
    expect(others.payments.read()).toHaveLength(1)
    expect(runEvidence(viewer, storage).payments.read()).toEqual([])
  })

  it("warns in plain words that the person could be paid twice", () => {
    expect(releaseWarning).toMatch(/may still have been sent/)
    expect(releaseWarning).toMatch(/paid twice/)
    expect(releaseWarning).toMatch(/payments and balance/)
  })
})

describe("saved payments that cannot be read", () => {
  it("hold every run for the viewer until released on purpose", () => {
    const storage = fakeStorage()
    const first = runEvidence(viewer, storage)
    paymentSending(first, RUN, prepared(1), 1_000)
    const key = [...storage.items.keys()].find((k) =>
      k.includes("payroll-payment"),
    )!
    storage.items.set(
      key,
      JSON.stringify([...JSON.parse(storage.items.get(key)!), { junk: 1 }]),
    )
    const reloaded = runEvidence(viewer, storage)
    expect(reloaded.payments.read()).toHaveLength(1)
    expect(reloaded.payments.unreadable()).toBe(true)
    expect(
      runEvidence(
        { ...viewer, email: "b@example.com" },
        storage,
      ).payments.unreadable(),
    ).toBe(false)
    reloaded.payments.clearUnreadable()
    expect(reloaded.payments.unreadable()).toBe(false)
  })
})

describe("records saved under the company name", () => {
  it("are read once under the id, and the old key is gone", () => {
    const storage = fakeStorage()
    const oldScope = stableHash(viewer.company, viewer.email)
    const old = runEvidence(
      { company: viewer.company, email: viewer.email },
      storage,
    )
    paymentSending(old, RUN, prepared(1), 1_000)
    beginAttempt(old, { idempotency_key: "k", fingerprint: "f" }, 1_000)
    expect(
      [...storage.items.keys()].every(
        (k) => k.endsWith(oldScope) || k.includes(oldScope),
      ),
    ).toBe(true)

    const migrated = runEvidence(viewer, storage)
    expect(migrated.payments.read()).toHaveLength(1)
    expect(savedAttempt(migrated, "f", 2_000)).not.toBeNull()
    expect([...storage.items.keys()].some((k) => k.includes(oldScope))).toBe(
      false,
    )
    // A rename of the company changes nothing for them.
    const renamed = runEvidence(
      { ...viewer, company: "Solaris Brasil" },
      storage,
    )
    expect(renamed.payments.read()).toHaveLength(1)
  })
})

describe("runSeenBefore", () => {
  it("is true for a run the browser was already given", () => {
    const evidence = runEvidence(viewer, fakeStorage())
    const saved = {
      idempotency_key: "k",
      fingerprint: "f",
      run_id: RUN,
      created_at: 1,
    }
    expect(runSeenBefore(evidence, saved, "another-run")).toBe(true)
  })

  it("is true for a run with a payment that may have been sent", () => {
    const evidence = runEvidence(viewer, fakeStorage())
    paymentSending(evidence, RUN, prepared(1), 1_000)
    expect(runSeenBefore(evidence, null, RUN)).toBe(true)
    expect(runSeenBefore(evidence, null, "another-run")).toBe(false)
  })

  it("is false for a run whose create answer was lost: its transactions are for signing", () => {
    const evidence = runEvidence(viewer, fakeStorage())
    const saved = { idempotency_key: "k", fingerprint: "f", created_at: 1 }
    expect(runSeenBefore(evidence, saved, RUN)).toBe(false)
    expect(runSeenBefore(evidence, null, RUN)).toBe(false)
  })
})
