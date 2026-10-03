import { describe, expect, it } from "vitest"
import { personSchema } from "./schema"

const valid = {
  name: "Bruno Costa",
  email: "bruno@solaris.example",
  kind: "employee",
  monthlyAmount: 4200,
}

describe("personSchema", () => {
  it("accepts a complete person and trims text", () => {
    const parsed = personSchema.parse({
      ...valid,
      name: "  Bruno Costa ",
      email: " bruno@solaris.example ",
    })
    expect(parsed.name).toBe("Bruno Costa")
    expect(parsed.email).toBe("bruno@solaris.example")
  })

  it.each([
    ["blank name", { name: "   " }],
    ["email without a domain", { email: "bruno@" }],
    ["email with spaces", { email: "bruno costa@solaris.example" }],
    ["unknown kind", { kind: "partner" }],
    ["zero amount", { monthlyAmount: 0 }],
    ["negative amount", { monthlyAmount: -5 }],
    ["missing amount", { monthlyAmount: undefined }],
    ["sub-cent precision", { monthlyAmount: 10.005 }],
    ["amount past 2^48 base units", { monthlyAmount: 300_000_000 }],
  ])("rejects %s", (_, patch) => {
    expect(personSchema.safeParse({ ...valid, ...patch }).success).toBe(false)
  })

  it("accepts cents", () => {
    expect(
      personSchema.safeParse({ ...valid, monthlyAmount: 4200.5 }).success,
    ).toBe(true)
  })
})
