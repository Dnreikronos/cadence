import { describe, expect, it } from "vitest"
import { maxBaseUnits } from "@/lib/deposit/schema"
import { maxWithdrawUnits, toWithdrawUnits } from "./schema"

const usdc = (whole: number) => BigInt(whole) * 1_000_000n

describe("toWithdrawUnits", () => {
  it("reads an exact amount in base units", () => {
    expect(toWithdrawUnits("12.345678", usdc(100))).toEqual({
      ok: true,
      units: 12_345_678n,
    })
  })

  it("allows the whole balance and one unit", () => {
    expect(toWithdrawUnits("100", usdc(100))).toEqual({
      ok: true,
      units: usdc(100),
    })
    expect(toWithdrawUnits("0.000001", usdc(100))).toEqual({
      ok: true,
      units: 1n,
    })
  })

  it("refuses one unit more than is available", () => {
    expect(toWithdrawUnits("100.000001", usdc(100))).toEqual({
      ok: false,
      message: "That is more than your available balance",
    })
  })

  it.each(["0", "0.00"])("refuses zero (%j)", (input) => {
    expect(toWithdrawUnits(input, usdc(100))).toEqual({
      ok: false,
      message: "The amount must be more than zero",
    })
  })

  it("refuses a seventh decimal instead of rounding it", () => {
    expect(toWithdrawUnits("1.0000001", usdc(100))).toEqual({
      ok: false,
      message: "Use at most six decimal places",
    })
  })

  it.each(["", "abc", "-5", "1e3"])("refuses %j", (input) => {
    const result = toWithdrawUnits(input, usdc(100))
    expect(result.ok).toBe(false)
  })

  it("refuses more than the per-transfer cap even when it is available", () => {
    const rich = maxBaseUnits * 2n
    expect(toWithdrawUnits("281474976.710656", rich)).toEqual({
      ok: false,
      message: "That amount is too large",
    })
    expect(toWithdrawUnits("281474976.710655", rich).ok).toBe(true)
  })
})

describe("maxWithdrawUnits", () => {
  it("is everything available", () => {
    expect(maxWithdrawUnits(8_000_000_000n)).toBe(8_000_000_000n)
  })

  it("stops at the cap, so Max is always an amount that validates", () => {
    const rich = maxBaseUnits * 3n
    expect(maxWithdrawUnits(rich)).toBe(maxBaseUnits)
    expect(toWithdrawUnits("281474976.710655", rich).ok).toBe(true)
  })
})
