import { describe, expect, it } from "vitest"
import {
  confirmedMessage,
  describeUsdc,
  doneMessage,
  doneToast,
  earlierFromBalance,
  earlierFromRecord,
  earlierToRecord,
} from "./message"

describe("doneMessage", () => {
  it("names the amount this run made private", () => {
    expect(doneMessage({ amount: "1000000" })).toBe(
      "1 USDC is now in your private balance. The move itself is public on-chain.",
    )
  })

  it("says so when an earlier pending deposit was applied too", () => {
    expect(
      doneMessage({ amount: "1000000", earlierPending: "200000000" }),
    ).toBe(
      "1 USDC is now in your private balance, and your earlier pending deposit (200 USDC) with it. The move itself is public on-chain.",
    )
  })

  it("says only that the pending USDC is available when nothing new was deposited", () => {
    expect(doneMessage({})).toBe(
      "Your pending USDC is now available to pay people.",
    )
    // No new amount: the earlier credit is the whole story, not a second clause.
    expect(doneMessage({ earlierPending: "5000000" })).toBe(
      "Your pending USDC is now available to pay people.",
    )
  })

  it("keeps a sub-cent amount exact", () => {
    expect(describeUsdc("1")).toBe("0.000001 USDC")
    expect(doneMessage({ amount: "1" })).toMatch(/^0\.000001 USDC is now/)
  })
})

describe("doneToast", () => {
  it("matches the notice", () => {
    expect(doneToast({ amount: "2500000000" })).toBe("2500 USDC is now private")
    expect(doneToast({ amount: "1000000", earlierPending: "200000000" })).toBe(
      "1 USDC is now private, with your earlier pending deposit (200 USDC)",
    )
    expect(doneToast({})).toBe("Your pending USDC is now available")
  })
})

describe("an earlier pending deposit that is not known", () => {
  it("is named without an amount", () => {
    expect(doneMessage({ amount: "1000000", earlierPending: null })).toBe(
      "1 USDC is now in your private balance, and any earlier pending deposit with it. The move itself is public on-chain.",
    )
    expect(doneToast({ amount: "1000000", earlierPending: null })).toBe(
      "1 USDC is now private, with any earlier pending deposit",
    )
  })
})

describe("confirmedMessage", () => {
  it("names what the credit covers, by amount, without one, or not at all", () => {
    expect(confirmedMessage("200000000")).toBe(
      "Your last deposit went through. If it is still pending, make it available above, together with your earlier pending deposit (200 USDC).",
    )
    expect(confirmedMessage(null)).toBe(
      "Your last deposit went through. If it is still pending, make it available above, together with any earlier pending deposit.",
    )
    expect(confirmedMessage(undefined)).toBe(
      "Your last deposit went through. If it is still pending, make it available above.",
    )
  })
})

describe("earlier pending, in and out of a record", () => {
  it("reads the balance: unknown, none, or an amount", () => {
    expect(earlierFromBalance(undefined)).toBeNull()
    expect(earlierFromBalance("0")).toBeUndefined()
    expect(earlierFromBalance("5")).toBe("5")
  })

  it("round-trips through the record", () => {
    for (const earlier of [null, undefined, "200000000"]) {
      expect(earlierFromRecord(earlierToRecord(earlier))).toBe(earlier)
    }
    expect(earlierToRecord(undefined)).toBe("0")
    expect(earlierToRecord(null)).toBeUndefined()
  })
})
