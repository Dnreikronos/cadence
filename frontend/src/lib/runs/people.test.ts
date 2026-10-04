import { describe, expect, it } from "vitest"
import { initialsOf, nameLookup, unknownPerson } from "./people"

describe("initialsOf", () => {
  it("takes the first letters of the first two words", () => {
    expect(initialsOf("Bruno Costa")).toBe("BC")
    expect(initialsOf("northwind audit ltda")).toBe("NA")
    expect(initialsOf("Madonna")).toBe("M")
  })
})

describe("nameLookup", () => {
  const people = [{ id: "a", name: "Bruno Costa" }]

  it("finds a person by id", () => {
    expect(nameLookup(people)("a")).toBe("Bruno Costa")
  })

  it("does not name someone it cannot find, or before the list loads", () => {
    expect(nameLookup(people)("gone")).toBe(unknownPerson)
    expect(nameLookup(undefined)("a")).toBe(unknownPerson)
  })
})
