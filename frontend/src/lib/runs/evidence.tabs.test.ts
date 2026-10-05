import { describe, expect, it, vi } from "vitest"
import type { RunPaymentPrepared } from "@/lib/api/schemas"
import { browserProfile } from "@/lib/browser-profile"
import { clearViewerEvidence, viewerScopeId } from "@/lib/submissions"
import {
  beginAttempt,
  paymentResolved,
  paymentSending,
  paymentSubmitted,
  releasePerson,
  runBlocker,
  runEvidence,
  runSeenBefore,
  savedAttempt,
  unreadableMessage,
  unsettledMessage,
  unsettledPeople,
} from "./evidence"

// What a second tab of the same browser sees of a payroll run the first has sent: the saved
// payments are shared, so whoever the first tab may have paid is not payable in the second.

const ana = { company: "Solaris", email: "ana@example.com" }
const bruno = { company: "Solaris", email: "bruno@example.com" }
const RUN = "c0000000-0000-4000-8000-000000000001"
const guid = (n: number) =>
  `b0000000-0000-4000-8000-${String(n).padStart(12, "0")}`
const prepared = (n: number): RunPaymentPrepared =>
  ({
    payment_id: guid(n),
    person_id: guid(100 + n),
    request_id: String(n).repeat(64).slice(0, 64),
    last_valid_block_height: 500 + n,
  }) as RunPaymentPrepared
const SIG = "5SigMockSignature1111111111111111111111111111"

describe("a payment sent in one tab, seen from another", () => {
  it("keeps its person out of a run made in the second tab, from the moment it is handed to the network", () => {
    const shared = browserProfile()
    const a = runEvidence(ana, shared.tab())
    const b = runEvidence(ana, shared.tab())
    expect(runBlocker(b, [{ id: guid(101) }, { id: guid(102) }])).toBeNull()

    paymentSending(a, RUN, prepared(1), 1_000)

    expect(unsettledPeople(b.payments.read())).toEqual(new Set([guid(101)]))
    expect(runBlocker(b, [{ id: guid(101) }, { id: guid(102) }])).toBe(
      unsettledMessage,
    )
    // A run for other people is not stopped.
    expect(runBlocker(b, [{ id: guid(102) }])).toBeNull()
  })

  it("still holds it once the signature is known, and frees it when the first tab has seen it through", () => {
    const shared = browserProfile()
    const a = runEvidence(ana, shared.tab())
    const b = runEvidence(ana, shared.tab())
    paymentSending(a, RUN, prepared(1), 1_000)
    paymentSubmitted(a, guid(1), SIG)
    expect(b.payments.read()).toEqual([
      expect.objectContaining({ payment_id: guid(1), signature: SIG }),
    ])
    expect(runBlocker(b, [{ id: guid(101) }])).toBe(unsettledMessage)

    paymentResolved(a, guid(1))

    expect(b.payments.read()).toEqual([])
    expect(runBlocker(b, [{ id: guid(101) }])).toBeNull()
  })

  it("is told to a subscribed second tab, so the person drops out of its list without a reload", () => {
    const shared = browserProfile()
    const a = runEvidence(ana, shared.tab())
    const b = runEvidence(ana, shared.tab())
    const heard = vi.fn()
    b.payments.subscribe(heard)

    paymentSending(a, RUN, prepared(1), 1_000)

    expect(heard).toHaveBeenCalledTimes(1)
    expect(unsettledPeople(b.payments.read()).has(guid(101))).toBe(true)
  })

  it("makes the second tab replay the first one's run, never sign it", () => {
    const shared = browserProfile()
    const a = runEvidence(ana, shared.tab())
    const b = runEvidence(ana, shared.tab())
    beginAttempt(a, { idempotency_key: "k1", fingerprint: "f1" }, 1_000)
    paymentSending(a, RUN, prepared(1), 1_000)

    const saved = savedAttempt(b, "f1", 2_000)

    expect(saved?.idempotency_key).toBe("k1")
    expect(runSeenBefore(b, saved, RUN)).toBe(true)
  })

  it("refuses a run while saved payments the second tab cannot read are set aside", () => {
    const shared = browserProfile()
    const key = `cadence:submissions:payroll-payment:${viewerScopeId(ana)}`
    shared.items.set(key, JSON.stringify([{ payment_id: 1 }]))
    const b = runEvidence(ana, shared.tab())

    expect(runBlocker(b, [{ id: guid(102) }])).toBe(unreadableMessage)

    b.payments.clearUnreadable()
    expect(runBlocker(b, [{ id: guid(102) }])).toBeNull()
  })

  it("is released for both tabs by the person's release in one of them", () => {
    const shared = browserProfile()
    const a = runEvidence(ana, shared.tab())
    const b = runEvidence(ana, shared.tab())
    paymentSending(a, RUN, prepared(1), 1_000)

    releasePerson(b, guid(101))

    expect(a.payments.read()).toEqual([])
    expect(runBlocker(a, [{ id: guid(101) }])).toBeNull()
  })

  it("is another person's to see never", () => {
    const shared = browserProfile()
    const anas = runEvidence(ana, shared.tab())
    const brunos = runEvidence(bruno, shared.tab())
    paymentSending(anas, RUN, prepared(1), 1_000)

    expect(brunos.payments.read()).toEqual([])
    expect(runBlocker(brunos, [{ id: guid(101) }])).toBeNull()
  })

  it("is gone from every tab when the viewer signs out", () => {
    const shared = browserProfile()
    const a = runEvidence(ana, shared.tab())
    const b = runEvidence(ana, shared.tab())
    beginAttempt(a, { idempotency_key: "k1", fingerprint: "f1" }, 1_000)
    paymentSending(a, RUN, prepared(1), 1_000)

    clearViewerEvidence(ana, shared.tab())

    expect(b.payments.read()).toEqual([])
    expect(b.attempts.read()).toEqual([])
    expect(shared.items.size).toBe(0)
  })
})
