import { describe, expect, it, vi } from "vitest"
import { paymentKey, type Signable } from "./executor"
import { createHeldStore, heldMarginBlocks, lookupHeld } from "./held"

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

// The last finalized height at which prepared(n) is still handed back.
const lastReady = (n: number) => 1000 + n - heldMarginBlocks

describe("lookupHeld", () => {
  it("has nothing to sign for a transaction this page never held", () => {
    expect(lookupHeld(undefined, 0)).toEqual({ status: "gone" })
  })

  it("hands back the transaction while its blockhash has time left at the chain's height", () => {
    const held = { prepared: prepared(1) }
    expect(lookupHeld(held, 900)).toEqual({
      status: "ready",
      prepared: held.prepared,
    })
    expect(lookupHeld(held, lastReady(1)).status).toBe("ready")
  })

  it("calls it stale once too few blocks are left to sign and land it", () => {
    const held = { prepared: prepared(1) }
    expect(lookupHeld(held, lastReady(1) + 1)).toEqual({ status: "stale" })
    expect(lookupHeld(held, 1001)).toEqual({ status: "stale" })
    expect(lookupHeld(held, 5000).status).toBe("stale")
  })

  it("calls it stale when the chain's height could not be read", () => {
    expect(lookupHeld({ prepared: prepared(1) }, null)).toEqual({
      status: "stale",
    })
  })

  it("keeps a margin for the finalized height trailing the tip, and for signing", () => {
    // The finalized height trails the tip by about 32 blocks; the rest is for the person
    // to sign, out of a blockhash's 150.
    expect(heldMarginBlocks).toBeGreaterThan(32)
    expect(heldMarginBlocks).toBeLessThan(150)
  })
})

describe("the held store", () => {
  it("holds a run's transactions by position, each with its own last valid block", () => {
    const store = createHeldStore(async () => 0)
    store.hold(key(1), prepared(1))
    store.hold(key(2), prepared(2))
    expect(store.has(key(1))).toBe(true)
    expect(store.lookup(key(2), lastReady(2))).toEqual({
      status: "ready",
      prepared: prepared(2),
    })
    expect(store.lookup(key(1), lastReady(2))).toEqual({ status: "stale" })
  })

  it("reads the finalized height, and none when the read fails", async () => {
    const heights = vi
      .fn<() => Promise<number>>()
      .mockResolvedValueOnce(812)
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
    const store = createHeldStore(heights)
    await expect(store.height()).resolves.toBe(812)
    await expect(store.height()).resolves.toBeNull()
  })

  it("keeps a transaction when it is only looked at, and loses it once dropped", () => {
    const store = createHeldStore(async () => 0)
    store.hold(key(1), prepared(1))
    store.lookup(key(1), 0)
    store.lookup(key(1), 0)
    expect(store.has(key(1))).toBe(true)
    store.drop(key(1))
    expect(store.has(key(1))).toBe(false)
    expect(store.lookup(key(1), 0)).toEqual({ status: "gone" })
  })

  it("replaces a transaction that a retry prepared for the same position", () => {
    const store = createHeldStore(async () => 0)
    store.hold(key(1), prepared(1))
    const replacement = {
      ...prepared(1),
      attempt: 1,
      request_id: "f".repeat(64),
    }
    store.hold(key(1), replacement)
    expect(store.lookup(key(1), 0)).toEqual({
      status: "ready",
      prepared: replacement,
    })
  })

  it("lists one run's held transactions in position order, and no other run's", () => {
    const store = createHeldStore(async () => 0)
    store.hold(key(2), prepared(2))
    store.hold(key(0), prepared(0))
    store.hold(paymentKey("another-run", 1), prepared(1))
    expect(store.ofRun(RUN).map((p) => p.position)).toEqual([0, 2])
  })
})
