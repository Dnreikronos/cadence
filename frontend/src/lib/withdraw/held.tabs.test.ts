import { describe, expect, it, vi } from "vitest"
import { ApiError } from "@/lib/api/errors"
import { browserProfile } from "@/lib/browser-profile"
import { clearSettledEvidence } from "@/lib/submissions"
import { initialWithdraw, withdrawReducer } from "./flow"
import {
  checkHeldWithdrawals,
  heldOf,
  heldRecords,
  releaseHeld,
  withdrawEvidence,
} from "./held"

// What a second tab of the same browser sees of a withdrawal the first has sent: the record
// of a withdrawal that may have gone through is shared, so the same amount is held in both.

const ana = { company: "Solaris", email: "ana@example.com" }
const bruno = { company: "Solaris", email: "bruno@example.com" }
const REQUEST = "a".repeat(64)
const SIG = "5SigMockSignature1111111111111111111111111111"
const AMOUNT = "1234560000"

const sentUnsigned = {
  request_id: REQUEST,
  last_valid_block_height: 500,
  signature: null,
}

function submitFrom(held: ReturnType<typeof heldOf>, amount: string) {
  return withdrawReducer(
    { ...initialWithdraw, held },
    { type: "submit", amount },
  ).stage
}

describe("a withdrawal sent in one tab, seen from another", () => {
  it("is held in the second tab from the moment it is handed to the network", () => {
    const shared = browserProfile()
    const a = heldRecords(bruno, shared.tab())
    const b = heldRecords(bruno, shared.tab())
    // The second tab opened first, with nothing held.
    expect(submitFrom(heldOf(b.read()), AMOUNT)).toBe("working")

    withdrawEvidence(a, AMOUNT, () => 1_000).onSent(sentUnsigned)

    expect(heldOf(b.read())).toEqual([{ amount: AMOUNT, signature: null }])
    // The very amount is refused there; another amount is its own withdrawal.
    expect(submitFrom(heldOf(b.read()), AMOUNT)).toBe("form")
    expect(submitFrom(heldOf(b.read()), "500250000")).toBe("working")
  })

  it("learns the signature once the first tab has it, and keeps the time of the send", () => {
    const shared = browserProfile()
    const a = heldRecords(bruno, shared.tab())
    const b = heldRecords(bruno, shared.tab())
    const evidence = withdrawEvidence(a, AMOUNT, () => 1_000)
    evidence.onSent(sentUnsigned)
    evidence.onSent({ ...sentUnsigned, signature: SIG })

    expect(b.read()).toEqual([
      expect.objectContaining({
        amount_units: AMOUNT,
        signature: SIG,
        at: 1_000,
      }),
    ])
  })

  it("is free in the second tab once the first has seen it through", () => {
    const shared = browserProfile()
    const a = heldRecords(bruno, shared.tab())
    const b = heldRecords(bruno, shared.tab())
    const evidence = withdrawEvidence(a, AMOUNT, () => 1_000)
    evidence.onSent({ ...sentUnsigned, signature: SIG })
    expect(b.read()).toHaveLength(1)

    evidence.onResolved()

    expect(b.read()).toEqual([])
    expect(submitFrom(heldOf(b.read()), AMOUNT)).toBe("working")
  })

  it("is told to a subscribed second tab, so its screen changes without a reload", () => {
    const shared = browserProfile()
    const a = heldRecords(bruno, shared.tab())
    const b = heldRecords(bruno, shared.tab())
    const heard = vi.fn()
    b.subscribe(heard)

    withdrawEvidence(a, AMOUNT, () => 1_000).onSent(sentUnsigned)

    expect(heard).toHaveBeenCalledTimes(1)
    expect(b.read()).toHaveLength(1)
  })

  it("is looked up and settled from the second tab, and the first sees it gone", async () => {
    const shared = browserProfile()
    const a = heldRecords(bruno, shared.tab())
    const b = heldRecords(bruno, shared.tab())
    withdrawEvidence(a, AMOUNT, () => 1_000).onSent({
      ...sentUnsigned,
      signature: SIG,
    })
    const refresh = vi.fn()

    const checks = await checkHeldWithdrawals({
      records: b,
      api: {
        unwrap: {
          confirm: vi.fn(async () => ({
            request_id: REQUEST,
            signature: SIG,
            slot: 1,
            status: "finalized" as const,
          })),
        },
      },
      refresh,
    })

    expect(checks).toEqual([{ amount: AMOUNT, outcome: "confirmed" }])
    expect(a.read()).toEqual([])
    expect(refresh).toHaveBeenCalled()
  })

  it("stays held in both tabs when the lookup cannot settle it", async () => {
    const shared = browserProfile()
    const a = heldRecords(bruno, shared.tab())
    const b = heldRecords(bruno, shared.tab())
    withdrawEvidence(a, AMOUNT, () => 1_000).onSent({
      ...sentUnsigned,
      signature: SIG,
    })

    const checks = await checkHeldWithdrawals({
      records: b,
      api: {
        unwrap: {
          confirm: vi.fn(async () => {
            throw new ApiError(404, "not_found")
          }),
        },
      },
      refresh: vi.fn(),
    })

    expect(checks).toEqual([{ amount: AMOUNT, outcome: "unknown" }])
    expect(a.read()).toHaveLength(1)
    expect(b.read()).toHaveLength(1)
  })

  it("is released for both tabs by the person's release in one of them", () => {
    const shared = browserProfile()
    const a = heldRecords(bruno, shared.tab())
    const b = heldRecords(bruno, shared.tab())
    withdrawEvidence(a, AMOUNT, () => 1_000).onSent(sentUnsigned)

    releaseHeld(b, AMOUNT)

    expect(a.read()).toEqual([])
  })

  it("is another person's to see never: the second tab of another viewer finds nothing", () => {
    const shared = browserProfile()
    const bruno1 = heldRecords(bruno, shared.tab())
    const ana1 = heldRecords(ana, shared.tab())
    withdrawEvidence(bruno1, AMOUNT, () => 1_000).onSent(sentUnsigned)

    expect(ana1.read()).toEqual([])
    expect(submitFrom(heldOf(ana1.read()), AMOUNT)).toBe("working")
  })

  it("stays held in every tab when the viewer signs out, for them and for no one else", () => {
    const shared = browserProfile()
    const a = heldRecords(bruno, shared.tab())
    const b = heldRecords(bruno, shared.tab())
    const anas = heldRecords(ana, shared.tab())
    withdrawEvidence(a, AMOUNT, () => 1_000).onSent(sentUnsigned)
    withdrawEvidence(anas, "7", () => 1_000).onSent(sentUnsigned)

    clearSettledEvidence(bruno, shared.tab())

    expect(a.read()).toHaveLength(1)
    expect(b.read()).toHaveLength(1)
    expect(anas.read()).toHaveLength(1)
    // Held means held: signing back in does not offer the amount again.
    expect(submitFrom(heldOf(b.read()), AMOUNT)).toBe("form")
    // And it is not another person's to read or to be stopped by.
    expect(
      heldRecords(ana, shared.tab())
        .read()
        .map((r) => r.amount_units),
    ).toEqual(["7"])
  })
})
