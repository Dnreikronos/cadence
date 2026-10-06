import { describe, expect, it } from "vitest"
import { paymentKey, type Signable } from "./executor"
import { createHeldStore, heldMaxAgeMs, lookupHeld } from "./held"

const RUN = "c0000000-0000-4000-8000-000000000001"
const prepared = (n: number): Signable => ({
  position: n,
  destination: `account${n}`,
  attempt: 0,
  request_id: String(n).repeat(64).slice(0, 64),
  status: "prepared",
  signature: null,
  slot: null,
  error: null,
  transaction: "AQID",
  last_valid_block_height: 1000 + n,
  required_signers: ["wallet"],
})
const key = (n: number) => paymentKey(RUN, n)

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

  it("lets go of a transaction once its blockhash may have run out, about a minute", () => {
    expect(heldMaxAgeMs).toBe(60_000)
  })
})

describe("the held store", () => {
  it("holds a run's transactions by position and ages them from when they were held", () => {
    let time = 0
    const store = createHeldStore(() => time)
    store.hold(key(1), prepared(1))
    store.hold(key(2), prepared(2))
    expect(store.has(key(1))).toBe(true)
    expect(store.lookup(key(2))).toEqual({
      status: "ready",
      prepared: prepared(2),
    })
    time = heldMaxAgeMs
    expect(store.lookup(key(1))).toEqual({ status: "stale" })
    // A transaction prepared later by a retry has its own age.
    store.hold(key(3), prepared(3))
    expect(store.lookup(key(3)).status).toBe("ready")
  })

  it("keeps a transaction when it is only looked at, and loses it once dropped", () => {
    const store = createHeldStore(() => 0)
    store.hold(key(1), prepared(1))
    store.lookup(key(1))
    store.lookup(key(1))
    expect(store.has(key(1))).toBe(true)
    store.drop(key(1))
    expect(store.has(key(1))).toBe(false)
    expect(store.lookup(key(1))).toEqual({ status: "gone" })
  })

  it("replaces a transaction that a retry prepared for the same position", () => {
    const store = createHeldStore(() => 0)
    store.hold(key(1), prepared(1))
    const replacement = {
      ...prepared(1),
      attempt: 1,
      request_id: "f".repeat(64),
    }
    store.hold(key(1), replacement)
    expect(store.lookup(key(1))).toEqual({
      status: "ready",
      prepared: replacement,
    })
  })

  it("lists one run's held transactions in position order, and no other run's", () => {
    const store = createHeldStore(() => 0)
    store.hold(key(2), prepared(2))
    store.hold(key(0), prepared(0))
    store.hold(paymentKey("another-run", 1), prepared(1))
    expect(store.ofRun(RUN).map((p) => p.position)).toEqual([0, 2])
  })
})
