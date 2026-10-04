import { describe, expect, it } from "vitest"
import { homeFor, type Role } from "@/lib/auth/guard"
import { homeLinks, isActive, navByRole } from "./nav"

const roles: Role[] = ["admin", "recipient", "auditor"]

describe("homeLinks", () => {
  it.each(roles)("sends %s back to their own home", (role) => {
    expect(homeLinks[role].href).toBe(homeFor(role))
    expect(homeLinks[role].label).toMatch(/^Back to /)
  })

  it.each(roles)("matches the first item of the %s navigation", (role) => {
    const [first] = navByRole[role].items
    expect(first.href).toBe(homeLinks[role].href)
    expect(isActive(first, homeLinks[role].href)).toBe(true)
  })
})
