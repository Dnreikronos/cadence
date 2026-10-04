import { describe, expect, it } from "vitest"
import { guard, safeNext, type Role } from "./guard"

describe("guard", () => {
  it("sends a signed-out visit to /company to sign-in, remembering where it was going", () => {
    expect(guard("/company", null)).toEqual({
      kind: "redirect",
      to: "/sign-in?next=%2Fcompany",
    })
  })

  it.each(["/", "/sign-in", "/companyx", "/media"])(
    "lets a signed-out visit to %s through",
    (path) => {
      expect(guard(path, null)).toEqual({
        kind: "next",
      })
    },
  )

  it.each<[string, Role]>([
    ["/company/people", "admin"],
    ["/me", "recipient"],
    ["/audit/export", "auditor"],
    ["/activate", "recipient"],
  ])("lets %s through for a member holding %s", (path, role) => {
    expect(guard(path, role)).toEqual({
      kind: "next",
    })
  })

  it("keeps /activate for recipients: others go home, the signed-out sign in first", () => {
    expect(guard("/activate", "admin")).toEqual({
      kind: "redirect",
      to: "/company",
    })
    expect(guard("/activate", null)).toEqual({
      kind: "redirect",
      to: "/sign-in?next=%2Factivate",
    })
  })

  it.each(["/activate/", "/activate/x"])(
    "guards %s like /activate itself",
    (path) => {
      expect(guard(path, "auditor")).toEqual({
        kind: "redirect",
        to: "/audit",
      })
      expect(guard(path, "recipient")).toEqual({ kind: "next" })
    },
  )

  it("does not guard a path that only starts with the same letters", () => {
    expect(guard("/activated", null)).toEqual({ kind: "next" })
  })

  it("sends a recipient away from /company to their own area, not back to sign-in", () => {
    expect(guard("/company", "recipient")).toEqual({
      kind: "redirect",
      to: "/me",
    })
  })
})

describe("safeNext", () => {
  it("returns to where an admin was going, query string included", () => {
    expect(safeNext("/company/people?tab=invites", "admin")).toBe(
      "/company/people?tab=invites",
    )
  })

  it("sends a recipient to their own area when there is nowhere to return to", () => {
    expect(safeNext(null, "recipient")).toBe("/me")
  })

  it("returns a recipient to /activate", () => {
    expect(safeNext("/activate", "recipient")).toBe("/activate")
  })

  it("ignores a path the role may not visit", () => {
    expect(safeNext("/company", "auditor")).toBe("/audit")
  })

  it.each([
    "//evil.example",
    "https://evil.example/me",
    "/\\evil.example",
    "me",
  ])("never leaves the site for %s", (next) => {
    expect(safeNext(next, "recipient")).toBe("/me")
  })
})
