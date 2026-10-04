import { describe, expect, it } from "vitest"
import { describeUsdc, doneMessage, doneToast } from "./message"

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
      "1 USDC is now private, with your earlier pending deposit",
    )
    expect(doneToast({})).toBe("Your pending USDC is now available")
  })
})
