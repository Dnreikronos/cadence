import { describe, expect, it } from "vitest"
import { initialsOf } from "./payments"

describe("initialsOf", () => {
  it("takes the first letter of the first two words", () => {
    expect(initialsOf("Bruno Costa")).toBe("BC")
    expect(initialsOf("ana maria de souza")).toBe("AM")
  })

  it("copes with one word, extra spaces and an empty name", () => {
    expect(initialsOf("Northwind")).toBe("N")
    expect(initialsOf("  Diego   Martins ")).toBe("DM")
    expect(initialsOf("")).toBe("?")
    expect(initialsOf("   ")).toBe("?")
  })

  it("does not split a character made of two code units", () => {
    expect(initialsOf("𝐀lice 𝐁ob")).toBe("𝐀𝐁")
  })
})
