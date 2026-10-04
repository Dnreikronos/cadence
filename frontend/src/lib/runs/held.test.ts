import { describe, expect, it } from "vitest"
import { EXPIRY_MS } from "@/lib/deposit/reconcile"
import type { RunPaymentPrepared } from "@/lib/api/schemas"
import { createHeldStore, heldMaxAgeMs, lookupHeld } from "./held"

const prepared = (n: number): RunPaymentPrepared => ({
  request_id: String(n).repeat(64).slice(0, 64),
  transaction: "AQID",
  transaction_version: 1,
  required_signers: ["wallet"],
  recent_blockhash: "blockhash",
  last_valid_block_height: 1000 + n,
  payment_id: `b0000000-0000-4000-8000-00000000000${n}`,
  person_id: `a0000000-0000-4000-8000-00000000000${n}`,
})

describe("lookupHeld", () => {
  it("has nothing to sign for a transaction this page never held", () => {
    expect(lookupHeld(undefined, 0)).toEqual({ status: "gone" })
  })

  it("hands back the transaction until its blockhash is past", () => {
    const held = { prepared: prepared(1), at: 1_000 }
    expect(lookupHeld(held, 1_000)).toEqual({
      status: "ready",
      prepared: held.prepared,
    })
    expect(lookupHeld(held, 1_000 + heldMaxAgeMs - 1).status).toBe("ready")
  })

  it("calls it stale from the moment a blockhash can no longer be live", () => {
    const held = { prepared: prepared(1), at: 1_000 }
    expect(lookupHeld(held, 1_000 + heldMaxAgeMs)).toEqual({ status: "stale" })
    expect(lookupHeld(held, 1_000 + 10 * heldMaxAgeMs).status).toBe("stale")
  })

  it("uses the same clock as the deposit's reconciliation", () => {
    expect(heldMaxAgeMs).toBe(EXPIRY_MS)
  })
})

describe("the held store", () => {
  it("holds a run's transactions by payment and ages them from when they were held", () => {
    let time = 0
    const store = createHeldStore(() => time)
    store.holdAll([prepared(1), prepared(2)])
    expect(store.has(prepared(1).payment_id)).toBe(true)
    expect(store.lookup(prepared(2).payment_id)).toEqual({
      status: "ready",
      prepared: prepared(2),
    })
    time = heldMaxAgeMs
    expect(store.lookup(prepared(1).payment_id)).toEqual({ status: "stale" })
    // A transaction prepared later by a retry has its own age.
    store.hold(prepared(3))
    expect(store.lookup(prepared(3).payment_id).status).toBe("ready")
  })

  it("keeps a transaction when it is only looked at, and loses it once dropped", () => {
    const store = createHeldStore(() => 0)
    store.hold(prepared(1))
    store.lookup(prepared(1).payment_id)
    store.lookup(prepared(1).payment_id)
    expect(store.has(prepared(1).payment_id)).toBe(true)
    store.drop(prepared(1).payment_id)
    expect(store.has(prepared(1).payment_id)).toBe(false)
    expect(store.lookup(prepared(1).payment_id)).toEqual({ status: "gone" })
  })

  it("replaces a transaction that a retry prepared for the same payment", () => {
    const store = createHeldStore(() => 0)
    store.hold(prepared(1))
    const replacement = { ...prepared(1), request_id: "f".repeat(64) }
    store.hold(replacement)
    expect(store.lookup(prepared(1).payment_id)).toEqual({
      status: "ready",
      prepared: replacement,
    })
  })
})
