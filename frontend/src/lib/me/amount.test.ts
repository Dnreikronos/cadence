import { describe, expect, it } from "vitest"
import { exactUsdc, isSubCent } from "./amount"

describe("isSubCent", () => {
  it("is true for a non-zero amount below one cent", () => {
    expect(isSubCent("1")).toBe(true)
    expect(isSubCent("9999")).toBe(true)
  })

  it("is false for zero, for exactly a cent, and for more", () => {
    expect(isSubCent("0")).toBe(false)
    expect(isSubCent("10000")).toBe(false)
    expect(isSubCent("1250000000")).toBe(false)
  })
})

describe("exactUsdc", () => {
  it("writes the amount out, so it never reads as $0.00", () => {
    expect(exactUsdc("1")).toBe("0.000001 USDC")
    expect(exactUsdc("9999")).toBe("0.009999 USDC")
  })
})
