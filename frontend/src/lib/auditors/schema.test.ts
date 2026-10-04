import { describe, expect, it } from "vitest"
import { inviteAuditorRequestSchema } from "@/lib/api/schemas"
import { auditorSchema } from "./schema"

const message = (email: string) => {
  const parsed = auditorSchema.safeParse({ email })
  return parsed.success ? undefined : parsed.error.issues[0].message
}

describe("auditorSchema", () => {
  it("trims the address it sends", () => {
    expect(auditorSchema.parse({ email: "  ana@firm.example \t" }).email).toBe(
      "ana@firm.example",
    )
  })

  it("asks for an address when the field is empty or only spaces", () => {
    expect(message("")).toBe("Enter an email address")
    expect(message("   ")).toBe("Enter an email address")
  })

  it("accepts an address of exactly 320 characters and refuses 321", () => {
    const local = "a".repeat(320 - "@b.co".length)
    expect(message(`${local}@b.co`)).toBeUndefined()
    expect(message(`${local}x@b.co`)).toBe("That email is too long")
  })

  it("measures the length after trimming", () => {
    const local = "a".repeat(320 - "@b.co".length)
    expect(message(`  ${local}@b.co  `)).toBeUndefined()
  })

  it.each([
    ["two at signs", "a@b@c"],
    ["no at sign", "ana.firm.example"],
    ["no domain", "ana@"],
    ["no local part", "@firm.example"],
    ["a space inside", "ana ribeiro@firm.example"],
    ["a tab inside", "ana\t@firm.example"],
  ])("refuses %s", (_name, email) => {
    expect(message(email)).toBe("Enter a valid email address")
  })

  it("never lets through an address the API would refuse", () => {
    const samples = [
      "ana@firm.example",
      " ana@firm.example ",
      "a+b@c",
      "a".repeat(400),
      "a@b@c",
      "",
    ]
    let accepted = 0
    for (const email of samples) {
      const parsed = auditorSchema.safeParse({ email })
      if (!parsed.success) continue
      accepted++
      expect(
        inviteAuditorRequestSchema.safeParse({ email: parsed.data.email })
          .success,
      ).toBe(true)
    }
    expect(accepted).toBe(3)
  })
})
