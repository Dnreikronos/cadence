import { describe, expect, it } from "vitest"
import { initialsOf, peopleByAccount } from "./people"

describe("initialsOf", () => {
  it("takes the first letters of the first two words", () => {
    expect(initialsOf("Bruno Costa")).toBe("BC")
    expect(initialsOf("northwind audit ltda")).toBe("NA")
    expect(initialsOf("Madonna")).toBe("M")
  })
})

describe("peopleByAccount", () => {
  const people = [
    { id: "a", tokenAccount: "AccountA" },
    { id: "b", tokenAccount: null },
  ]

  it("finds a person by the account a payment went to", () => {
    expect(peopleByAccount(people)("AccountA")?.id).toBe("a")
  })

  it("finds no one for an unknown account, or before the list has answered", () => {
    expect(peopleByAccount(people)("Other")).toBeUndefined()
    expect(peopleByAccount(undefined)("AccountA")).toBeUndefined()
  })
})
