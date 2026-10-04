import { describe, expect, it } from "vitest"
import type { Role } from "@/lib/auth/guard"
import { demoAllowed, type DemoEnv } from "./allowed"
import { DEMO_COOKIE, demoRoles, demoViewer, parseDemoRole } from "./viewer"

describe("demoAllowed", () => {
  const demo: DemoEnv = {
    mode: "mock",
    supabaseConfigured: false,
    isMainnet: false,
  }

  it("is on for the mock API without Supabase", () => {
    expect(demoAllowed({ ...demo, mode: "mock" })).toBe(true)
  })

  it("is off when Supabase is configured", () => {
    expect(demoAllowed({ ...demo, supabaseConfigured: true })).toBe(false)
  })

  it("is off against the real API", () => {
    expect(demoAllowed({ ...demo, mode: "real" })).toBe(false)
  })

  it("is off on mainnet", () => {
    expect(demoAllowed({ ...demo, isMainnet: true })).toBe(false)
  })

  it("is off when more than one condition fails", () => {
    expect(
      demoAllowed({ mode: "real", supabaseConfigured: true, isMainnet: true }),
    ).toBe(false)
  })
})

describe("parseDemoRole", () => {
  it.each(["admin", "recipient", "auditor"])("accepts %s", (role) => {
    expect(parseDemoRole(role)).toBe(role)
  })

  it.each([undefined, null, "", "Admin", "root", "admin ", 1, {}, ["admin"]])(
    "reads %j as no role",
    (value) => {
      expect(parseDemoRole(value)).toBeNull()
    },
  )

  it("names the cookie the sign-out action clears", () => {
    expect(DEMO_COOKIE).toBe("cadence-demo-role")
  })
})

describe("demoViewer", () => {
  it.each<[Role, string]>([
    ["admin", "ana@solaris.test"],
    ["recipient", "bruno@solaris.test"],
    ["auditor", "carla@acme-audit.test"],
  ])("makes the %s viewer", (role, email) => {
    expect(demoViewer(role)).toEqual({
      email,
      membership: { role, company: { name: "Solaris" } },
    })
  })

  it("has a viewer for every role the sign-in offers", () => {
    expect(demoRoles).toEqual(["admin", "recipient", "auditor"])
    for (const role of demoRoles) {
      expect(demoViewer(role).membership.role).toBe(role)
    }
  })
})
