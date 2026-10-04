import { describe, expect, it } from "vitest"
import {
  formatUnits,
  maxBaseUnits,
  sumUnits,
  unitsToUsd,
  usdToUnits,
} from "./money"

const max = maxBaseUnits.toString()

describe("unitsToUsd", () => {
  it.each([
    ["0", 0],
    ["1", 0.000001],
    ["1000000", 1],
    ["2500000000", 2500],
    ["1500000", 1.5],
  ])("reads %s units as %d USD", (units, usd) => {
    expect(unitsToUsd(units)).toBe(usd)
    expect(unitsToUsd(BigInt(units))).toBe(usd)
  })

  it("keeps every digit of the largest transfer", () => {
    expect(unitsToUsd(max)).toBe(281_474_976.710655)
    // The six decimals survive the trip back, so nothing was lost on the way.
    expect(unitsToUsd(max).toFixed(6)).toBe("281474976.710655")
  })

  it.each(["", "-1", "1.5", "1e6", " 1", "abc"])("rejects %j", (units) => {
    expect(() => unitsToUsd(units)).toThrow(RangeError)
  })

  it("rejects a negative bigint", () => {
    expect(() => unitsToUsd(-1n)).toThrow(RangeError)
  })
})

describe("usdToUnits", () => {
  it.each([
    ["0", "0"],
    ["0.000001", "1"],
    ["1", "1000000"],
    ["1.5", "1500000"],
    ["1,234.56", "1234560000"],
    ["2500", "2500000000"],
    [".5", "500000"],
    [" 12.000000 ", "12000000"],
    ["281474976.710655", max],
  ])("reads %j as %s units", (usd, units) => {
    expect(usdToUnits(usd)).toBe(units)
  })

  it("never rounds a seventh decimal", () => {
    expect(() => usdToUnits("0.0000001")).toThrow(/six decimal/)
    expect(() => usdToUnits("1.2345675")).toThrow(/six decimal/)
  })

  it("stops at the transfer cap", () => {
    expect(() => usdToUnits("281474976.710656")).toThrow(/too large/)
  })

  it.each(["", "  ", "abc", "-1", "1e3", "1,5", "1.2.3", "$5"])(
    "rejects %j",
    (usd) => {
      expect(() => usdToUnits(usd)).toThrow(RangeError)
    },
  )

  it("is the inverse of unitsToUsd on whole numbers of units", () => {
    for (const units of ["0", "1", "999999", "1000001", max]) {
      expect(usdToUnits(unitsToUsd(units).toFixed(6))).toBe(units)
    }
  })
})

describe("formatUnits", () => {
  it.each([
    ["0", "$0.00"],
    ["1500000", "$1.50"],
    ["84000000000", "$84,000.00"],
    ["1234560000", "$1,234.56"],
  ])("formats %s as %s", (units, text) => {
    expect(formatUnits(units)).toBe(text)
  })

  it("shows a single unit as the cents it rounds to, only for display", () => {
    expect(formatUnits("1")).toBe("$0.00")
  })

  it("formats the largest transfer", () => {
    expect(formatUnits(max)).toBe("$281,474,976.71")
  })
})

describe("sumUnits", () => {
  it("is zero for an empty list", () => {
    expect(sumUnits([])).toBe("0")
  })

  it("adds strings and bigints exactly", () => {
    expect(sumUnits(["1", 2n, "3000000"])).toBe("3000003")
  })

  it("stays exact past the point where doubles lose units", () => {
    // 2^53 + 1 is not a double; BigInt keeps it.
    expect(sumUnits(["9007199254740992", "1"])).toBe("9007199254740993")
  })

  it("adds up to the cap and beyond without wrapping", () => {
    expect(sumUnits([max, "1"])).toBe((maxBaseUnits + 1n).toString())
  })

  it("rejects a malformed entry", () => {
    expect(() => sumUnits(["1", "1.5"])).toThrow(RangeError)
  })
})
