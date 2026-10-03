import { describe, expect, it } from "vitest"
import {
  baseUnitsToUsdc,
  formatBaseUnits,
  maxBaseUnits,
  parseAmount,
  toBaseUnits,
} from "./schema"

const usdc = (whole: number) => BigInt(whole) * 1_000_000n

describe("parseAmount", () => {
  it.each([
    ["1200", "1200"],
    ["1,200.50", "1200.50"],
    ["1,500", "1500"],
    ["1,500.25", "1500.25"],
    [" 0.000001 ", "0.000001"],
    [".5", ".5"],
    ["5.", "5."],
  ])("reads %j", (input, expected) => {
    expect(parseAmount(input)).toBe(expected)
  })

  it.each([
    "",
    "  ",
    "abc",
    "1e3",
    "-5",
    "1.2.3",
    "$10",
    ".",
    "1,5",
    "1,2,3",
    "1,50",
    "1,5000",
    ",500",
    "1,500,",
    "1.500,25",
  ])("rejects %j", (input) => {
    expect(parseAmount(input)).toBeUndefined()
  })
})

describe("toBaseUnits", () => {
  const balance = usdc(1000)

  it.each([
    ["1000", usdc(1000)],
    ["1,000", usdc(1000)],
    ["0.000001", 1n],
    ["5.", usdc(5)],
    [".5", 500_000n],
    ["12.345678", 12_345_678n],
    ["0007", usdc(7)],
  ])("accepts %j", (input, units) => {
    expect(toBaseUnits(input, balance)).toEqual({ ok: true, units })
  })

  it.each([
    ["", "Enter an amount"],
    ["abc", "Enter an amount"],
    ["1,5", "Enter an amount"],
    ["0", "The amount must be more than zero"],
    ["0.000000", "The amount must be more than zero"],
    ["1000.000001", "That is more public USDC than you hold"],
    ["1.0000001", "Use at most six decimal places"],
    ["0.0000000000001", "Use at most six decimal places"],
  ])("rejects %j", (input, message) => {
    expect(toBaseUnits(input, balance)).toEqual({ ok: false, message })
  })

  it("accepts exactly the 48-bit deposit limit", () => {
    expect(maxBaseUnits).toBe(281_474_976_710_655n)
    expect(toBaseUnits("281474976.710655", maxBaseUnits)).toEqual({
      ok: true,
      units: maxBaseUnits,
    })
  })

  it("rejects one base unit above the 48-bit deposit limit", () => {
    const above = maxBaseUnits + 1n
    expect(toBaseUnits("281474976.710656", above)).toEqual({
      ok: false,
      message: "That amount is too large",
    })
  })

  it("rejects 400 digits cleanly", () => {
    const huge = "9".repeat(400)
    expect(toBaseUnits(huge, balance)).toEqual({
      ok: false,
      message: "That is more public USDC than you hold",
    })
    expect(toBaseUnits(huge, 10n ** 500n)).toEqual({
      ok: false,
      message: "That amount is too large",
    })
    expect(toBaseUnits(`0.${"1".repeat(400)}`, balance)).toEqual({
      ok: false,
      message: "Use at most six decimal places",
    })
  })

  it("compares the balance exactly", () => {
    // 0.1 + 0.2 is 0.30000000000000004 as floats; here it is exact.
    expect(toBaseUnits("0.3", 300_000n)).toEqual({ ok: true, units: 300_000n })
    expect(toBaseUnits("0.300001", 300_000n).ok).toBe(false)
  })

  it("lets Max round-trip a balance that floats would have blurred", () => {
    // 12500 - 0.1 - 0.2 as floats is 12499.699999999999.
    const balance = usdc(12_500) - 100_000n - 200_000n
    const typed = formatBaseUnits(balance)
    expect(typed).toBe("12499.7")
    expect(toBaseUnits(typed, balance)).toEqual({ ok: true, units: balance })
  })
})

describe("formatBaseUnits", () => {
  it.each([
    [0n, "0"],
    [1n, "0.000001"],
    [500_000n, "0.5"],
    [usdc(12_500), "12500"],
    [12_345_670n, "12.34567"],
    [maxBaseUnits, "281474976.710655"],
  ])("formats %s as %j", (units, expected) => {
    expect(formatBaseUnits(units)).toBe(expected)
  })

  it("round-trips through toBaseUnits", () => {
    for (const units of [1n, 999_999n, 1_000_001n, maxBaseUnits]) {
      expect(toBaseUnits(formatBaseUnits(units), maxBaseUnits)).toEqual({
        ok: true,
        units,
      })
    }
  })
})

describe("baseUnitsToUsdc", () => {
  it("shows base units as USDC", () => {
    expect(baseUnitsToUsdc(12_499_700_000n)).toBe(12_499.7)
    expect(baseUnitsToUsdc(1n)).toBe(0.000001)
  })
})
