import { describe, expect, it } from "vitest"
import { makePrivateSchema, parseAmount } from "./schema"

describe("parseAmount", () => {
  it.each([
    ["1200", 1200],
    ["1,200.50", 1200.5],
    [" 0.000001 ", 0.000001],
    [".5", 0.5],
  ])("reads %j", (input, expected) => {
    expect(parseAmount(input)).toBe(expected)
  })

  it.each(["", "  ", "abc", "1e3", "-5", "1.2.3", "$10"])(
    "rejects %j",
    (input) => {
      expect(parseAmount(input)).toBeUndefined()
    },
  )
})

describe("makePrivateSchema", () => {
  const schema = makePrivateSchema(1000)

  it("accepts up to the public balance", () => {
    expect(schema.safeParse(1000).success).toBe(true)
    expect(schema.safeParse(0.000001).success).toBe(true)
  })

  it.each([
    ["missing", undefined],
    ["zero", 0],
    ["negative", -1],
    ["over the balance", 1000.01],
    ["past six decimals", 1.0000001],
  ])("rejects %s", (_, value) => {
    expect(schema.safeParse(value).success).toBe(false)
  })

  it("never allows more than the 48-bit deposit limit", () => {
    expect(makePrivateSchema(1e12).safeParse(300_000_000).success).toBe(false)
  })
})
