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
    expect(nameLookup(people, true)("a")).toBe("Bruno Costa")
  })

  it("does not name someone the answered list does not have", () => {
    expect(nameLookup(people, true)("gone")).toBe(unknownPerson)
    // The list failed to load: still an answer, with no name for anyone.
    expect(nameLookup(undefined, true)("a")).toBe(unknownPerson)
  })

  it("has no name at all until the list has answered", () => {
    expect(nameLookup(undefined, false)("a")).toBeUndefined()
    expect(nameLookup(people, false)("a")).toBeUndefined()
  })
})
